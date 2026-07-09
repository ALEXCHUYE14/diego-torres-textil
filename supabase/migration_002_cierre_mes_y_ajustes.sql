-- ============================================================================
--  DIEGO TORRES · Migración 002
--  Ejecutar completo en el SQL Editor de Supabase (después de schema.sql).
--
--  Incluye:
--   1. Tabla periodos_bloqueados + RPCs de bloqueo/desbloqueo (cierre de mes)
--   2. Enforcement estricto del cierre dentro de rpc_registrar_entrada y
--      rpc_registrar_salida (server-side: no se puede saltar desde el cliente)
--   3. rpc_registrar_salida ahora acepta proveedor_id (módulo Salidas)
--   4. RLS de periodos_bloqueados: consulta = lectura, operativo = bloquear/desbloquear
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. TABLA · periodos_bloqueados (cierre contable mensual)
--    p_anio_mes se normaliza siempre al primer día del mes (date_trunc).
-- ----------------------------------------------------------------------------
create table if not exists periodos_bloqueados (
  anio_mes    date primary key,      -- siempre normalizado al día 1 del mes
  bloqueado_por uuid references auth.users(id),
  bloqueado_en  timestamptz not null default now(),
  nota          text
);

alter table periodos_bloqueados enable row level security;

drop policy if exists sel_periodos_bloqueados on periodos_bloqueados;
create policy sel_periodos_bloqueados on periodos_bloqueados
  for select to authenticated using (true);

drop policy if exists ins_periodos_bloqueados on periodos_bloqueados;
create policy ins_periodos_bloqueados on periodos_bloqueados
  for insert to authenticated with check (fn_rol_actual() = 'operativo');

drop policy if exists del_periodos_bloqueados on periodos_bloqueados;
create policy del_periodos_bloqueados on periodos_bloqueados
  for delete to authenticated using (fn_rol_actual() = 'operativo');

-- ----------------------------------------------------------------------------
-- 2. FUNCIÓN AUXILIAR · lanza excepción si el mes de la fecha dada está cerrado
-- ----------------------------------------------------------------------------
create or replace function fn_verificar_periodo_abierto(p_fecha timestamptz)
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
-- 3. RPCs · bloquear / desbloquear período (solo rol operativo)
-- ----------------------------------------------------------------------------
create or replace function rpc_bloquear_periodo(p_anio_mes date, p_nota text default null)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mes date := date_trunc('month', p_anio_mes)::date;
begin
  if fn_rol_actual() <> 'operativo' then
    raise exception 'Permiso denegado: se requiere rol Operativo';
  end if;

  insert into periodos_bloqueados (anio_mes, bloqueado_por, nota)
  values (v_mes, auth.uid(), p_nota)
  on conflict (anio_mes) do update set nota = excluded.nota;

  return json_build_object('anio_mes', v_mes, 'bloqueado', true);
end $$;

create or replace function rpc_desbloquear_periodo(p_anio_mes date)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mes date := date_trunc('month', p_anio_mes)::date;
begin
  if fn_rol_actual() <> 'operativo' then
    raise exception 'Permiso denegado: se requiere rol Operativo';
  end if;

  delete from periodos_bloqueados where anio_mes = v_mes;

  return json_build_object('anio_mes', v_mes, 'bloqueado', false);
end $$;

-- ----------------------------------------------------------------------------
-- 4. rpc_registrar_entrada · agrega verificación de período cerrado
--    (misma firma que en schema.sql — CREATE OR REPLACE la reemplaza entera)
-- ----------------------------------------------------------------------------
create or replace function rpc_registrar_entrada(
  p_producto_id     uuid,
  p_tipo_movimiento text,
  p_cantidad        numeric,
  p_valor_unitario  numeric,
  p_proveedor_id    uuid,
  p_nro_factura     text default null,
  p_nro_orden       text default null,
  p_concepto        text default null,
  p_fecha           date default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prod        productos%rowtype;
  v_consecutivo text;
  v_nuevo_cpp   numeric;
  v_nuevo_stock numeric;
  v_fecha       timestamptz;
begin
  if fn_rol_actual() <> 'operativo' then
    raise exception 'Permiso denegado: se requiere rol Operativo';
  end if;
  if p_cantidad <= 0 then raise exception 'La cantidad debe ser mayor a 0'; end if;
  if p_valor_unitario < 0 then raise exception 'El valor unitario no puede ser negativo'; end if;
  if p_tipo_movimiento not in ('1000','1002','1007','1210') then
    raise exception 'Tipo de movimiento de entrada no autorizado';
  end if;

  -- Calendario restringido al mes/año actual del servidor
  v_fecha := coalesce(p_fecha::timestamptz, now());
  if date_trunc('month', v_fecha) <> date_trunc('month', now()) then
    raise exception 'La fecha debe pertenecer al mes y año actual';
  end if;

  -- Cierre de mes: bloquea estrictamente si el período está cerrado
  perform fn_verificar_periodo_abierto(v_fecha);

  select * into v_prod from productos where id_producto = p_producto_id for update;
  if not found then raise exception 'Producto no encontrado'; end if;

  v_nuevo_stock := v_prod.stock_real + p_cantidad;
  -- CPP = (stock*cpp + cantidad*valor) / (stock + cantidad)
  v_nuevo_cpp := case when v_nuevo_stock = 0 then p_valor_unitario
    else round(((v_prod.stock_real * v_prod.costo_promedio_ponderado)
              + (p_cantidad * p_valor_unitario)) / v_nuevo_stock, 4) end;

  update productos set
    stock_real = v_nuevo_stock,
    costo_promedio_ponderado = v_nuevo_cpp,
    ultimo_valor_unitario = p_valor_unitario
  where id_producto = p_producto_id;

  v_consecutivo := fn_siguiente_consecutivo('ENT');

  insert into historial_movimientos (tipo_consecutivo, tipo_movimiento, naturaleza,
    fecha_registro, producto_id, cantidad, valor_unitario, valor_total,
    proveedor_id, nro_factura, nro_orden, concepto, usuario_id, stock_resultante)
  values (v_consecutivo, p_tipo_movimiento, 'ENTRADA', v_fecha, p_producto_id,
    p_cantidad, p_valor_unitario, round(p_cantidad * p_valor_unitario, 2),
    p_proveedor_id, p_nro_factura, p_nro_orden, p_concepto, auth.uid(), v_nuevo_stock);

  return json_build_object('consecutivo', v_consecutivo, 'nuevo_stock', v_nuevo_stock, 'nuevo_cpp', v_nuevo_cpp);
end $$;

-- ----------------------------------------------------------------------------
-- 5. rpc_registrar_salida · agrega p_proveedor_id + verificación de período
--    NOTA: se agrega el nuevo parámetro AL FINAL con default null para no
--    romper si algo más en la base todavía invoca la firma anterior.
-- ----------------------------------------------------------------------------
create or replace function rpc_registrar_salida(
  p_producto_id     uuid,
  p_tipo_movimiento text,
  p_cantidad        numeric,
  p_cliente_id      uuid default null,
  p_nro_factura     text default null,
  p_nro_orden       text default null,
  p_concepto        text default null,
  p_proveedor_id    uuid default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prod        productos%rowtype;
  v_consecutivo text;
  v_nuevo_stock numeric;
  v_ahora       timestamptz := now();
begin
  if fn_rol_actual() <> 'operativo' then
    raise exception 'Permiso denegado: se requiere rol Operativo';
  end if;
  if p_cantidad <= 0 then raise exception 'La cantidad debe ser mayor a 0'; end if;
  if p_tipo_movimiento not in ('2000','2003') then
    raise exception 'Tipo de movimiento de salida no autorizado';
  end if;

  -- Cierre de mes: bloquea estrictamente si el período está cerrado
  perform fn_verificar_periodo_abierto(v_ahora);

  select * into v_prod from productos where id_producto = p_producto_id for update;
  if not found then raise exception 'Producto no encontrado'; end if;

  if p_cantidad > v_prod.stock_real then
    raise exception 'STOCK_INSUFICIENTE: disponible %, solicitado %', v_prod.stock_real, p_cantidad;
  end if;

  v_nuevo_stock := v_prod.stock_real - p_cantidad;
  update productos set stock_real = v_nuevo_stock where id_producto = p_producto_id;

  v_consecutivo := fn_siguiente_consecutivo('SAL');

  insert into historial_movimientos (tipo_consecutivo, tipo_movimiento, naturaleza,
    fecha_registro, producto_id, cantidad, valor_unitario, valor_total,
    cliente_id, proveedor_id, nro_factura, nro_orden, concepto, usuario_id, stock_resultante)
  values (v_consecutivo, p_tipo_movimiento, 'SALIDA', v_ahora, p_producto_id,
    p_cantidad, v_prod.costo_promedio_ponderado,
    round(p_cantidad * v_prod.costo_promedio_ponderado, 2),
    p_cliente_id, p_proveedor_id, p_nro_factura, p_nro_orden, p_concepto, auth.uid(), v_nuevo_stock);

  return json_build_object('consecutivo', v_consecutivo, 'nuevo_stock', v_nuevo_stock,
    'valor_unitario', v_prod.costo_promedio_ponderado);
end $$;

-- ============================================================================
-- Fin de la migración 002.
-- ============================================================================
