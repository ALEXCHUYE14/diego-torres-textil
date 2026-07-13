-- ============================================================================
--  DIEGO TORRES · Migración 009 — Botón "Eliminar todo el catálogo"
--  Ejecutar en el SQL Editor de Supabase después de la migración 008.
--
--  Expone como RPC (invocable desde la app, con verificación de rol en el
--  servidor) el mismo reinicio que hasta ahora se hacía a mano con
--  reset_inventario_prueba.sql: borra todos los artículos junto con su
--  historial de movimientos y ventas, y reinicia los consecutivos.
--
--  Un artículo con movimientos en el kardex no se puede borrar sin borrar
--  también esos movimientos (llave foránea historial_movimientos.producto_id
--  sin "on delete cascade", a propósito, para que un borrado accidental de
--  UN artículo nunca se lleve su historial por delante). Por eso esta acción
--  masiva borra ambas cosas explícitamente, en el orden correcto para no
--  violar ninguna llave foránea.
--
--  Exclusivo de Administrador — mismo criterio que eliminar un artículo
--  individual. NO toca: familias, terceros (proveedores), colores, tallas,
--  generos, usuarios, periodos_bloqueados (los meses ya cerrados siguen
--  cerrados).
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

  delete from venta_items;
  delete from ventas;
  delete from historial_movimientos;
  delete from productos;

  update consecutivos set ultimo = 0 where tipo in ('ENT', 'SAL', 'TCK');
  update familias set consecutivo_familia = 0;

  return json_build_object(
    'articulos_eliminados', v_articulos,
    'movimientos_eliminados', v_movimientos
  );
end $$;

-- ============================================================================
-- Fin de la migración 009.
-- ============================================================================
