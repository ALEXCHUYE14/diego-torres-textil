-- ============================================================================
--  DIEGO TORRES · Migración 014 — Fecha real de registro en el Kardex
--  Ejecutar en el SQL Editor de Supabase después de la migración 013.
--  Segura de volver a ejecutar (guardas "if not exists" / "if exists").
--
--  Problema que corrige:
--  En "Kardex → Todos los movimientos" la única fecha que se mostraba era
--  `fecha_registro`, que NO es un instante real: es el día de calendario
--  que el usuario elige a mano al digitar una entrada o salida (ver
--  rpc_registrar_entrada_lote / rpc_registrar_salida_lote, migración 006/007),
--  guardado como medianoche UTC explícita de ese día. Si el usuario digita
--  hoy un movimiento fechado el 01/03/2026 (inicio de operación), la fila
--  muestra "01/03/2026" aunque se haya registrado hoy — eso es correcto para
--  el kardex contable, pero no hay forma de saber CUÁNDO se digitó realmente
--  cada movimiento en el sistema (trazabilidad/auditoría).
--
--  Solución: se agrega `fecha_creacion`, un timestamp real (instante del
--  servidor al momento del INSERT, con default now()), independiente de
--  `fecha_registro`. Los movimientos ya existentes no tienen forma de saber
--  su instante real de creación, así que se rellenan con su propio
--  `fecha_registro` como mejor aproximación disponible (ver nota del bloque
--  de backfill). De aquí en adelante, cada INSERT nuevo (que no menciona
--  esta columna) recibe automáticamente el instante real vía el DEFAULT —
--  no hace falta tocar las funciones rpc_registrar_entrada_lote/
--  rpc_registrar_salida_lote/rpc_registrar_venta.
--
--  IMPORTANTE — no confundir en el frontend:
--   · fecha_registro → fecha de MOVIMIENTO (día de calendario elegido por el
--     usuario). Se sigue formateando con fechaMovimiento() (UTC explícito).
--   · fecha_creacion → fecha/hora REAL de registro en el sistema (instante).
--     Se formatea con fechaSegura() (hora local), tal como ya advertía el
--     comentario de esa función en src/utils/format.ts antes de que esta
--     columna existiera.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Columna nueva + backfill, protegidos para que la migración se pueda
--    volver a correr sin pisar datos reales ya capturados después del alta.
-- ----------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_name = 'historial_movimientos' and column_name = 'fecha_creacion'
  ) then
    alter table historial_movimientos
      add column fecha_creacion timestamptz not null default now();

    -- Backfill único: para los movimientos que ya existían antes de esta
    -- migración no hay registro del instante real en que se digitaron, así
    -- que se usa fecha_registro como mejor aproximación disponible (mismo
    -- criterio que ya usaba fecha_registro para las salidas, que siempre se
    -- guardaban con now()). Va DENTRO de este mismo "if" para que, si el
    -- archivo se ejecuta una segunda vez por error, no vuelva a sobrescribir
    -- los valores reales que ya se hayan acumulado desde el alta.
    update historial_movimientos set fecha_creacion = fecha_registro;
  end if;
end $$;

create index if not exists idx_mov_fecha_creacion on historial_movimientos (fecha_creacion);

-- ----------------------------------------------------------------------------
-- 2. rpc_kardex_general · agrega fecha_creacion a la vista "Todos los
--    movimientos". El filtro de rango (p_desde/p_hasta) sigue operando
--    sobre fecha_registro (fecha de movimiento) — sin cambios ahí, para no
--    alterar qué filas trae cada búsqueda ya existente.
-- ----------------------------------------------------------------------------
create or replace function rpc_kardex_general(
  p_desde date,
  p_hasta date
)
returns json
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_hasta_ts timestamptz;
  v_rows     json;
begin
  if p_desde > p_hasta then
    raise exception 'La fecha "Desde" no puede ser posterior a la fecha "Hasta"';
  end if;

  v_hasta_ts := (p_hasta + 1)::timestamptz;

  select coalesce(json_agg(t order by t.fecha_registro desc, t.tipo_consecutivo desc), '[]'::json) into v_rows
  from (
    select
      m.tipo_consecutivo, m.documento_numero, m.tipo_movimiento, m.naturaleza,
      m.fecha_registro, m.fecha_creacion, m.cantidad, m.valor_unitario, m.valor_total, m.stock_resultante,
      m.nro_factura, m.concepto,
      p.codigo_barra as producto_codigo, p.nombre as producto_nombre,
      ter.razon_social as proveedor,
      (select nombre from usuarios where id_usuario = m.usuario_id) as usuario_nombre
    from historial_movimientos m
    join productos p on p.id_producto = m.producto_id
    left join terceros ter on ter.id_proveedor = m.proveedor_id
    where m.fecha_registro >= p_desde::timestamptz and m.fecha_registro < v_hasta_ts
  ) t;

  return v_rows;
end $$;

-- ----------------------------------------------------------------------------
-- 3. rpc_kardex_producto · misma columna agregada en el kardex "Por
--    artículo", por consistencia (evita que una pantalla la tenga y la
--    otra no).
-- ----------------------------------------------------------------------------
create or replace function rpc_kardex_producto(
  p_producto_id uuid,
  p_modo        text default 'MES',
  p_anio        integer default null
)
returns json
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_desde timestamptz;
  v_hasta timestamptz;
  v_rows  json;
begin
  if p_modo = 'MES' then
    v_desde := date_trunc('month', now());
    v_hasta := now();
  elsif p_modo = 'ANIO' then
    v_desde := date_trunc('year', now());
    v_hasta := now();
  else
    if p_anio is null then raise exception 'Debe indicar el año histórico'; end if;
    v_desde := make_timestamptz(p_anio, 1, 1, 0, 0, 0);
    v_hasta := make_timestamptz(p_anio, 12, 31, 23, 59, 59);
  end if;

  select coalesce(json_agg(t order by t.fecha_registro desc), '[]'::json) into v_rows
  from (
    select m.tipo_consecutivo, m.tipo_movimiento, m.naturaleza, m.fecha_registro, m.fecha_creacion,
           m.cantidad, m.valor_unitario, m.valor_total, m.stock_resultante,
           m.nro_factura, m.concepto, ter.razon_social as proveedor
    from historial_movimientos m
    left join terceros ter on ter.id_proveedor = m.proveedor_id
    where m.producto_id = p_producto_id
      and m.fecha_registro is not null                       -- validación estricta de nulos
      and m.fecha_registro >= '1990-01-01'::timestamptz      -- descarta fechas basura (30/12/1899)
      and m.fecha_registro between v_desde and v_hasta
  ) t;

  return v_rows;
end $$;

-- ============================================================================
-- Fin de la migración 014.
-- ============================================================================
