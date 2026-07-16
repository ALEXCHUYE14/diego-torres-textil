-- ============================================================================
--  DIEGO TORRES · Migración 012 — Registro general de movimientos (Kardex)
--  Ejecutar en el SQL Editor de Supabase después de la migración 011.
--
--  Hasta ahora Kardex solo permitía consultar UN artículo a la vez (había
--  que buscarlo primero). No existía ninguna vista que mostrara TODOS los
--  movimientos (de todos los artículos) registrados en un rango de fechas,
--  así que no había forma de verificar de un vistazo todo lo digitado en
--  un día. Este RPC nuevo alimenta esa vista, agregada en la pantalla de
--  Kardex como una segunda pestaña "Todos los movimientos".
-- ============================================================================

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

  -- Mismo patrón de rpc_informe_cierre: límite superior exclusivo al día
  -- siguiente de "hasta", para no depender de la zona horaria de la sesión.
  v_hasta_ts := (p_hasta + 1)::timestamptz;

  select coalesce(json_agg(t order by t.fecha_registro desc, t.tipo_consecutivo desc), '[]'::json) into v_rows
  from (
    select
      m.tipo_consecutivo, m.documento_numero, m.tipo_movimiento, m.naturaleza,
      m.fecha_registro, m.cantidad, m.valor_unitario, m.valor_total, m.stock_resultante,
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

-- ============================================================================
-- Fin de la migración 012.
-- ============================================================================
