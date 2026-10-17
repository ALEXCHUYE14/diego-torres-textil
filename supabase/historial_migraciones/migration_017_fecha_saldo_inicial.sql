-- ============================================================================
--  DIEGO TORRES · Migración 017 — Fecha real del saldo inicial (carga masiva)
--  Incluida en supabase/actualizar_base.sql (ejecute ese archivo, no este).
--
--  Problema: rpc_importar_articulo_inicial registraba SIEMPRE el saldo
--  inicial con fecha_registro = 01/03/2026 (inicio de operación), sin
--  importar cuándo se hacía la carga. Un catálogo cargado el 14/10/2026
--  aparecía en el kardex y en el respaldo como movido en marzo.
--
--  Solución: nuevo parámetro p_fecha (fecha contable del saldo inicial).
--   · Si no se envía, se usa la fecha de HOY en Colombia (America/Bogota).
--   · Mismas reglas que una entrada normal: no antes del 01/03/2026, no
--     posterior a hoy, y el mes no puede estar cerrado.
--   · Se guarda como medianoche UTC de ese día (igual que Entradas/Salidas,
--     ver migración 006), para que se muestre el mismo día en Colombia.
--  Se elimina la versión anterior de 8 parámetros: si conviviera con la
--  nueva, la llamada sin p_fecha sería ambigua para PostgREST.
-- ============================================================================

drop function if exists rpc_importar_articulo_inicial(text, text, uuid, text, text, text, numeric, numeric);

create or replace function rpc_importar_articulo_inicial(
  p_codigo_barra  text,
  p_nombre        text,
  p_id_familia    uuid,
  p_genero        text default null,
  p_color         text default null,
  p_talla         text default null,
  p_saldo_inicial numeric default 0,
  p_valor_inicial numeric default 0,
  p_fecha         date default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_producto    productos%rowtype;
  v_codigo      text := upper(trim(p_codigo_barra));
  v_nombre      text := upper(trim(p_nombre));
  v_genero      text := nullif(upper(trim(coalesce(p_genero, ''))), '');
  v_color       text := nullif(upper(trim(coalesce(p_color, ''))), '');
  v_talla       text := nullif(upper(trim(coalesce(p_talla, ''))), '');
  v_hoy         date := (now() at time zone 'America/Bogota')::date;
  v_fecha       date := coalesce(p_fecha, (now() at time zone 'America/Bogota')::date);
  v_consecutivo text;
begin
  if not fn_puede_escribir() then
    raise exception 'Permiso denegado: se requiere rol Operativo o Administrador';
  end if;
  if v_codigo = '' then raise exception 'El código del producto es obligatorio'; end if;
  if v_nombre = '' then raise exception 'El nombre es obligatorio'; end if;
  if p_saldo_inicial < 0 then raise exception 'El saldo inicial no puede ser negativo'; end if;
  if p_valor_inicial < 0 then raise exception 'El valor inicial no puede ser negativo'; end if;

  if p_saldo_inicial > 0 then
    if v_fecha < date '2026-03-01' then
      raise exception 'La fecha del saldo inicial no puede ser anterior al 01/03/2026 (inicio de operación del sistema)';
    end if;
    -- greatest(): tolera la diferencia de un día entre la fecha UTC del
    -- servidor y la de Colombia a última hora de la noche.
    if v_fecha > greatest(v_hoy, current_date) then
      raise exception 'La fecha del saldo inicial no puede ser posterior a hoy';
    end if;
    perform fn_verificar_periodo_abierto(v_fecha);
  end if;

  begin
    insert into productos (codigo_barra, nombre, genero, color, talla, id_familia,
      valor_unitario_inicial, ultimo_valor_unitario, costo_promedio_ponderado, stock_real, precio_venta)
    values (v_codigo, v_nombre, v_genero, v_color, v_talla, p_id_familia,
      p_valor_inicial, p_valor_inicial, p_valor_inicial, 0, 0)
    returning * into v_producto;
  exception when unique_violation then
    raise exception 'Ya existe un artículo con el código "%" o con el mismo nombre/género/color/talla en esta familia', v_codigo;
  end;

  if p_saldo_inicial > 0 then
    v_consecutivo := fn_siguiente_consecutivo('ENT');
    update productos set stock_real = p_saldo_inicial where id_producto = v_producto.id_producto;

    insert into historial_movimientos (tipo_consecutivo, documento_numero, tipo_movimiento, naturaleza,
      fecha_registro, producto_id, cantidad, valor_unitario, valor_total, concepto, usuario_id, stock_resultante)
    values (v_consecutivo, v_consecutivo, '1007', 'ENTRADA',
      make_timestamptz(extract(year from v_fecha)::int, extract(month from v_fecha)::int, extract(day from v_fecha)::int, 0, 0, 0, 'UTC'),
      v_producto.id_producto, p_saldo_inicial, p_valor_inicial, round(p_saldo_inicial * p_valor_inicial, 2),
      'Saldo inicial · carga masiva de catálogo', auth.uid(), p_saldo_inicial);
  end if;

  return json_build_object('id_producto', v_producto.id_producto, 'codigo_barra', v_producto.codigo_barra);
end $$;

-- ============================================================================
-- Fin de la migración 017.
-- ============================================================================
