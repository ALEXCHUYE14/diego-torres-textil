-- ============================================================================
--  DIEGO TORRES · Migración 006 — Corrección crítica de zona horaria
--  Ejecutar en el SQL Editor de Supabase después de las migraciones 003-005.
--
--  Diagnóstico del bug:
--  Al registrar una entrada/salida con fecha "01/03/2026", el frontend envía
--  la fecha como texto plano 'YYYY-MM-DD' (correcto, sin problema ahí). El
--  problema estaba en el servidor: las funciones convertían esa fecha a
--  timestamptz con un cast implícito (`p_fecha::timestamptz`), que depende
--  de la zona horaria de la SESIÓN de Postgres para decidir qué instante es
--  "medianoche" de ese día. Si esa sesión no está en UTC de forma explícita,
--  o cuando el navegador del usuario (en una zona horaria detrás de UTC,
--  como Colombia/Perú) vuelve a convertir ese instante a su hora local para
--  mostrarlo, el resultado se corre un día hacia atrás — exactamente el
--  síntoma reportado: "01 de marzo" se guardaba/mostraba como "28 de
--  febrero", y por eso el bloqueo de mes activaba febrero en vez de marzo.
--
--  Solución:
--   1. fn_verificar_periodo_abierto ahora recibe DATE (no timestamptz) y
--      hace toda la comparación en aritmética de fechas puras, sin ninguna
--      conversión de zona horaria de por medio — cero ambigüedad posible.
--   2. rpc_registrar_entrada_lote / rpc_registrar_salida_lote construyen el
--      timestamp de forma EXPLÍCITA en UTC con make_timestamptz(...,'UTC'),
--      sin depender de la configuración de la sesión, y pasan la fecha
--      original (date) al chequeo de mes bloqueado en vez del timestamp ya
--      convertido.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. fn_verificar_periodo_abierto · ahora trabaja con DATE, no timestamptz
-- ----------------------------------------------------------------------------
create or replace function fn_verificar_periodo_abierto(p_fecha date)
returns void
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_mes date := date_trunc('month', p_fecha)::date;
  v_bloqueado boolean;
begin
  select exists(select 1 from periodos_bloqueados where anio_mes = v_mes) into v_bloqueado;
  if v_bloqueado then
    raise exception 'PERIODO_CERRADO: El período % está cerrado. No se pueden registrar, editar ni eliminar movimientos de ese mes.',
      to_char(v_mes, 'MM/YYYY');
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 2. rpc_registrar_entrada_lote · fecha construida explícitamente en UTC +
--    verificación de período con la fecha original (date), sin conversión
-- ----------------------------------------------------------------------------
create or replace function rpc_registrar_entrada_lote(
  p_fecha           date,
  p_tipo_movimiento text,
  p_proveedor_id    uuid,
  p_items           jsonb,
  p_nro_factura     text default null,
  p_nro_orden       text default null,
  p_concepto        text default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item        jsonb;
  v_prod        productos%rowtype;
  v_doc         text;
  v_linea       int := 0;
  v_fecha_ts    timestamptz;
  v_cant        numeric;
  v_valor       numeric;
  v_nuevo_stock numeric;
  v_nuevo_cpp   numeric;
  v_lineas      json[] := array[]::json[];
begin
  if fn_rol_actual() <> 'operativo' then
    raise exception 'Permiso denegado: se requiere rol Operativo';
  end if;
  if p_tipo_movimiento not in ('1000','1002','1007','1210') then
    raise exception 'Tipo de movimiento de entrada no autorizado';
  end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'La entrada no tiene artículos';
  end if;

  if p_fecha < date '2026-03-01' then
    raise exception 'La fecha no puede ser anterior al 01/03/2026 (inicio de operación del sistema)';
  end if;
  if p_fecha > current_date then
    raise exception 'La fecha no puede ser posterior a hoy';
  end if;
  -- Se verifica con la fecha original (date), sin pasar por ninguna
  -- conversión de zona horaria: cero riesgo de desfase de un día.
  perform fn_verificar_periodo_abierto(p_fecha);

  -- Instante guardado en el kardex: medianoche UTC explícita del día
  -- elegido, construida sin depender de la zona horaria de la sesión.
  v_fecha_ts := make_timestamptz(
    extract(year from p_fecha)::int, extract(month from p_fecha)::int, extract(day from p_fecha)::int,
    0, 0, 0, 'UTC'
  );

  v_doc := fn_siguiente_consecutivo('ENT');

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_linea := v_linea + 1;
    v_cant  := (v_item->>'cantidad')::numeric;
    v_valor := (v_item->>'valor_unitario')::numeric;
    if v_cant is null or v_cant <= 0 then
      raise exception 'Línea %: la cantidad debe ser mayor a 0', v_linea;
    end if;
    if v_valor is null or v_valor < 0 then
      raise exception 'Línea %: el valor unitario no puede ser negativo', v_linea;
    end if;

    select * into v_prod from productos
    where id_producto = (v_item->>'producto_id')::uuid for update;
    if not found then
      raise exception 'Línea %: producto no encontrado', v_linea;
    end if;

    v_nuevo_stock := v_prod.stock_real + v_cant;
    v_nuevo_cpp := case when v_nuevo_stock = 0 then v_valor
      else round(((v_prod.stock_real * v_prod.costo_promedio_ponderado) + (v_cant * v_valor)) / v_nuevo_stock, 4) end;

    update productos set
      stock_real = v_nuevo_stock,
      costo_promedio_ponderado = v_nuevo_cpp,
      ultimo_valor_unitario = v_valor
    where id_producto = v_prod.id_producto;

    insert into historial_movimientos (tipo_consecutivo, documento_numero, tipo_movimiento, naturaleza,
      fecha_registro, producto_id, cantidad, valor_unitario, valor_total,
      proveedor_id, nro_factura, nro_orden, concepto, usuario_id, stock_resultante)
    values (v_doc || '-' || lpad(v_linea::text, 2, '0'), v_doc, p_tipo_movimiento, 'ENTRADA', v_fecha_ts,
      v_prod.id_producto, v_cant, v_valor, round(v_cant * v_valor, 2),
      p_proveedor_id, p_nro_factura, p_nro_orden, p_concepto, auth.uid(), v_nuevo_stock);

    v_lineas := v_lineas || json_build_object('producto', v_prod.nombre, 'cantidad', v_cant, 'nuevo_stock', v_nuevo_stock);
  end loop;

  return json_build_object('documento', v_doc, 'lineas', v_linea, 'detalle', array_to_json(v_lineas));
end $$;

-- ----------------------------------------------------------------------------
-- 3. rpc_registrar_salida_lote · mismo tratamiento explícito en UTC
-- ----------------------------------------------------------------------------
create or replace function rpc_registrar_salida_lote(
  p_fecha           date,
  p_tipo_movimiento text,
  p_items           jsonb,
  p_proveedor_id    uuid default null,
  p_concepto        text default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item        jsonb;
  v_prod        productos%rowtype;
  v_doc         text;
  v_linea       int := 0;
  v_fecha_ts    timestamptz;
  v_cant        numeric;
  v_nuevo_stock numeric;
  v_lineas      json[] := array[]::json[];
begin
  if fn_rol_actual() <> 'operativo' then
    raise exception 'Permiso denegado: se requiere rol Operativo';
  end if;
  if p_tipo_movimiento not in ('2000','2003') then
    raise exception 'Tipo de movimiento de salida no autorizado';
  end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'La salida no tiene artículos';
  end if;

  if p_fecha < date '2026-03-01' then
    raise exception 'La fecha no puede ser anterior al 01/03/2026 (inicio de operación del sistema)';
  end if;
  if p_fecha > current_date then
    raise exception 'La fecha no puede ser posterior a hoy';
  end if;
  perform fn_verificar_periodo_abierto(p_fecha);

  v_fecha_ts := make_timestamptz(
    extract(year from p_fecha)::int, extract(month from p_fecha)::int, extract(day from p_fecha)::int,
    0, 0, 0, 'UTC'
  );

  v_doc := fn_siguiente_consecutivo('SAL');

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_linea := v_linea + 1;
    v_cant := (v_item->>'cantidad')::numeric;
    if v_cant is null or v_cant <= 0 then
      raise exception 'Línea %: la cantidad debe ser mayor a 0', v_linea;
    end if;

    select * into v_prod from productos
    where id_producto = (v_item->>'producto_id')::uuid for update;
    if not found then
      raise exception 'Línea %: producto no encontrado', v_linea;
    end if;
    if v_cant > v_prod.stock_real then
      raise exception 'Línea % (%): STOCK_INSUFICIENTE — disponible %, solicitado %', v_linea, v_prod.nombre, v_prod.stock_real, v_cant;
    end if;

    v_nuevo_stock := v_prod.stock_real - v_cant;
    update productos set stock_real = v_nuevo_stock where id_producto = v_prod.id_producto;

    insert into historial_movimientos (tipo_consecutivo, documento_numero, tipo_movimiento, naturaleza,
      fecha_registro, producto_id, cantidad, valor_unitario, valor_total,
      proveedor_id, concepto, usuario_id, stock_resultante)
    values (v_doc || '-' || lpad(v_linea::text, 2, '0'), v_doc, p_tipo_movimiento, 'SALIDA', v_fecha_ts,
      v_prod.id_producto, v_cant, v_prod.costo_promedio_ponderado, round(v_cant * v_prod.costo_promedio_ponderado, 2),
      p_proveedor_id, p_concepto, auth.uid(), v_nuevo_stock);

    v_lineas := v_lineas || json_build_object('producto', v_prod.nombre, 'cantidad', v_cant, 'nuevo_stock', v_nuevo_stock);
  end loop;

  return json_build_object('documento', v_doc, 'lineas', v_linea, 'detalle', array_to_json(v_lineas));
end $$;

-- ============================================================================
-- Fin de la migración 006.
-- ============================================================================
