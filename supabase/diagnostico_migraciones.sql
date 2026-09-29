-- ============================================================================
--  DIEGO TORRES · Diagnóstico de migraciones (solo lectura, no modifica nada)
--  Ejecutar en el SQL Editor de Supabase para saber qué migraciones ya están
--  aplicadas. Toda fila con aplicada = false indica una migración pendiente:
--  ejecútelas en orden, empezando por la de número más bajo.
-- ============================================================================
select migracion, aplicada from (values
  ('001 schema.sql',                    to_regclass('public.productos') is not null),
  ('002 cierre_mes_y_ajustes',          to_regclass('public.periodos_bloqueados') is not null),
  ('004 rediseno_operativo',            exists (select 1 from pg_proc where proname = 'rpc_registrar_entrada_lote')),
  ('007 rbac',                          exists (select 1 from pg_proc where proname = 'fn_es_administrador')),
  ('008 desactivar_articulos',          exists (select 1 from information_schema.columns
                                          where table_schema = 'public' and table_name = 'productos' and column_name = 'tiene_movimientos')),
  ('009/010 purgar_catalogo',           exists (select 1 from pg_proc where proname = 'rpc_purgar_catalogo')),
  ('012 kardex_general',                exists (select 1 from pg_proc where proname = 'rpc_kardex_general')),
  ('013 busqueda_optimizada',           exists (select 1 from pg_proc where proname = 'rpc_buscar_productos')),
  ('014/015 fecha_creacion_movimiento', exists (select 1 from information_schema.columns
                                          where table_schema = 'public' and table_name = 'historial_movimientos' and column_name = 'fecha_creacion')),
  ('016 correccion_valor_producto',     exists (select 1 from pg_proc where proname = 'rpc_corregir_valor_producto'))
) as t(migracion, aplicada)
order by migracion;

-- El SQL Editor solo muestra el resultado de la última consulta. Para ver
-- los usuarios y sus roles, ejecute aparte esta otra:
--   select u.nombre, a.email, u.rol from public.usuarios u
--   join auth.users a on a.id = u.id_usuario order by u.rol, u.nombre;
