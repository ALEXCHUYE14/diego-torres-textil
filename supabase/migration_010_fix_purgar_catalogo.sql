-- ============================================================================
--  DIEGO TORRES · Migración 010 — Corrige rpc_purgar_catalogo
--  Ejecutar en el SQL Editor de Supabase después de la migración 009.
--
--  Bug encontrado al probar el botón "Eliminar todo el catálogo": Supabase
--  Postgres corre con la extensión "safeupdate" activa, que rechaza
--  cualquier DELETE/UPDATE sin cláusula WHERE explícita —protección para
--  no borrar una tabla completa por accidente— con el error:
--    "DELETE requires a WHERE clause"
--  La migración 009 tenía justamente eso: "delete from productos;" sin
--  WHERE. Se corrige agregando "where true" (borra exactamente las mismas
--  filas, pero ahora sí trae una cláusula WHERE explícita).
-- ============================================================================

create or replace function rpc_purgar_catalogo()
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_articulos   integer;
  v_movimientos integer;
begin
  if not fn_es_administrador() then
    raise exception 'Permiso denegado: solo un Administrador puede eliminar todo el catálogo';
  end if;

  select count(*) into v_articulos from productos;
  select count(*) into v_movimientos from historial_movimientos;

  delete from venta_items where true;
  delete from ventas where true;
  delete from historial_movimientos where true;
  delete from productos where true;

  update consecutivos set ultimo = 0 where tipo in ('ENT', 'SAL', 'TCK');
  update familias set consecutivo_familia = 0 where true;

  return json_build_object(
    'articulos_eliminados', v_articulos,
    'movimientos_eliminados', v_movimientos
  );
end $$;

-- ============================================================================
-- Fin de la migración 010.
-- ============================================================================
