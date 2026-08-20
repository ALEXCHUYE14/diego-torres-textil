-- ============================================================================
--  DIEGO TORRES · Migración 016 — Corrección de valor de inventario (9000)
--  Ejecutar en el SQL Editor de Supabase después de la migración 015.
--  Segura de volver a ejecutar (create or replace / drop-and-recreate del
--  único CHECK que toca).
--
--  Necesidad que resuelve:
--  El costo de un artículo (productos.costo_promedio_ponderado) puede
--  quedar mal digitado (error de captura en una entrada pasada, saldo
--  inicial cargado con el valor equivocado, etc.). Hasta ahora la única
--  forma de tocar ese valor era registrar una entrada real
--  (rpc_registrar_entrada_lote), que SIEMPRE suma cantidad al stock — no
--  sirve para "solo corregir el valor" sin alterar las existencias
--  físicas, que es justo lo que se necesita: la bata sigue teniendo el
--  mismo stock, solo cambia el costo con el que está valorizada.
--
--  Se agrega el tipo de movimiento 9000 "Corrección de valor de
--  inventario", con su propio RPC (rpc_corregir_valor_producto):
--
--   - EXCLUSIVO de Administrador. A diferencia de entradas/salidas
--     normales (Operativo o Administrador), corregir el costo de un
--     artículo es una operación contable sensible que puede alterar la
--     valorización de todo el inventario — se exige fn_es_administrador(),
--     no solo fn_puede_escribir().
--   - NO toca productos.stock_real: el trigger de bloqueo de mes y demás
--     reglas de stock ni se rozan, porque este RPC nunca hace
--     `stock_real = stock_real ± algo`.
--   - Si deja rastro en el kardex (historial_movimientos), con
--     tipo_movimiento='9000' y naturaleza='ENTRADA' (así lo pidió el
--     negocio: "un movimiento en entrada"), para trazabilidad de quién
--     corrigió qué valor, cuándo y con qué concepto — pero con
--     CANTIDAD = 0 a propósito. Esto es la pieza clave para no romper
--     nada: rpc_detalle_producto y rpc_informe_cierre reconstruyen el
--     stock al INICIO de un período restándole a las existencias
--     actuales la cantidad de los movimientos ENTRADA/SALIDA de ese
--     período. Si esta corrección sumara cantidad como una entrada real,
--     esa reconstrucción retrospectiva del stock quedaría mal (como si
--     hubiese entrado mercancía que en realidad nunca entró). Con
--     cantidad=0 esa resta no se altera y el stock inicial reconstruido
--     sigue siendo exacto.
--   - Guarda en valor_unitario el costo NUEVO (para que se vea directo en
--     el kardex, no un delta) y en valor_total el IMPACTO total del
--     ajuste: (valor_nuevo − valor_anterior) × stock_actual. No es
--     cosmético: rpc_informe_cierre reconstruye el valor de inventario al
--     INICIO de un período restando al valor actual la suma de
--     valor_total de los movimientos ENTRADA (menos SALIDA) de ese
--     período. Con este valor_total, esa cuenta también da exacta:
--       valor_actual − impacto
--         = (stock × valor_nuevo) − (stock × (valor_nuevo − valor_anterior))
--         = stock × valor_anterior   ← valor real antes de la corrección.
--
--  Requiere relajar el CHECK de historial_movimientos.cantidad (antes
--  exigía "> 0" estrictamente) a ">= 0", únicamente para permitir este
--  caso. Ningún otro RPC existente pasa cantidad=0: rpc_registrar_
--  entrada_lote, rpc_registrar_salida_lote y rpc_registrar_venta siguen
--  validando "cantidad > 0" en su propio código antes de insertar, así
--  que relajar el CHECK de tabla no abre ninguna puerta nueva ahí.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. historial_movimientos.cantidad · CHECK relajado de "> 0" a ">= 0"
--    (búsqueda dinámica del nombre real del constraint — mismo patrón que
--    usa la migración 007 para el CHECK de usuarios.rol — más robusto que
--    adivinar el nombre autogenerado por Postgres)
-- ----------------------------------------------------------------------------
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'historial_movimientos'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%cantidad%'
  loop
    execute format('alter table historial_movimientos drop constraint %I', c.conname);
  end loop;
end $$;

alter table historial_movimientos add constraint historial_movimientos_cantidad_check
  check (cantidad >= 0);

-- ----------------------------------------------------------------------------
-- 2. RPC · rpc_corregir_valor_producto — exclusiva de Administrador
-- ----------------------------------------------------------------------------
create or replace function rpc_corregir_valor_producto(
  p_producto_id uuid,
  p_valor_nuevo numeric,
  p_fecha       date default null,
  p_concepto    text default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prod        productos%rowtype;
  v_consecutivo text;
  v_fecha       date := coalesce(p_fecha, current_date);
  v_fecha_ts    timestamptz;
  v_valor_antes numeric;
  v_impacto     numeric;
  v_concepto    text := coalesce(nullif(trim(p_concepto), ''), 'Corrección de valor de inventario');
begin
  if not fn_es_administrador() then
    raise exception 'Permiso denegado: la corrección de valor de inventario es exclusiva del rol Administrador';
  end if;
  if p_valor_nuevo is null or p_valor_nuevo < 0 then
    raise exception 'El valor nuevo no puede ser negativo';
  end if;

  if v_fecha < date '2026-03-01' then
    raise exception 'La fecha no puede ser anterior al 01/03/2026 (inicio de operación del sistema)';
  end if;
  if v_fecha > current_date then
    raise exception 'La fecha no puede ser posterior a hoy';
  end if;
  -- Mismo respeto al cierre de mes que cualquier otro movimiento: si el
  -- período de la fecha elegida está cerrado, no se puede corregir ahí.
  perform fn_verificar_periodo_abierto(v_fecha);

  select * into v_prod from productos where id_producto = p_producto_id for update;
  if not found then raise exception 'Producto no encontrado'; end if;
  if not v_prod.activo then
    raise exception 'No se puede corregir el valor de un artículo inactivo. Actívelo primero desde Artículos.';
  end if;

  v_valor_antes := v_prod.costo_promedio_ponderado;
  if p_valor_nuevo = v_valor_antes then
    raise exception 'El valor nuevo es igual al valor actual del producto (%), no hay nada que corregir', v_valor_antes;
  end if;

  v_impacto := round((p_valor_nuevo - v_valor_antes) * v_prod.stock_real, 2);

  v_fecha_ts := make_timestamptz(
    extract(year from v_fecha)::int, extract(month from v_fecha)::int, extract(day from v_fecha)::int,
    0, 0, 0, 'UTC'
  );

  update productos set costo_promedio_ponderado = p_valor_nuevo
  where id_producto = p_producto_id;

  -- Reutiliza la serie de consecutivos ENT: sigue siendo, de cara al
  -- usuario, "un movimiento en entrada" — un único documento de una línea,
  -- imprimible desde el mismo módulo de Imprimir (Entrada de Almacén).
  v_consecutivo := fn_siguiente_consecutivo('ENT');

  -- cantidad = 0 a propósito (ver nota de cabecera): es una corrección de
  -- costo, no una entrada de mercancía. stock_resultante = stock actual,
  -- porque el stock no cambia con este movimiento.
  insert into historial_movimientos (tipo_consecutivo, documento_numero, tipo_movimiento, naturaleza,
    fecha_registro, producto_id, cantidad, valor_unitario, valor_total, concepto, usuario_id, stock_resultante)
  values (v_consecutivo, v_consecutivo, '9000', 'ENTRADA', v_fecha_ts,
    p_producto_id, 0, p_valor_nuevo, v_impacto, v_concepto, auth.uid(), v_prod.stock_real);

  return json_build_object(
    'consecutivo', v_consecutivo,
    'producto', v_prod.nombre,
    'valor_anterior', v_valor_antes,
    'valor_nuevo', p_valor_nuevo,
    'stock_actual', v_prod.stock_real
  );
end $$;

-- ============================================================================
-- Fin de la migración 016.
-- ============================================================================
