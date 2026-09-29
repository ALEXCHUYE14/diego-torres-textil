-- ============================================================================
--  DIEGO TORRES · Reinicio de datos transaccionales de prueba
--  Ejecutar en el SQL Editor de Supabase SOLO cuando quieras vaciar el
--  catálogo de artículos y su historial para empezar limpio.
--
--  ⚠️ ADVERTENCIA — ACCIÓN DESTRUCTIVA E IRREVERSIBLE ⚠️
--  Esto borra PERMANENTEMENTE:
--    - Todos los artículos (productos)
--    - Todo el historial de movimientos (Entradas y Salidas / kardex)
--    - Todas las ventas de prueba del módulo POS (si las hay)
--  Y reinicia:
--    - Los consecutivos de Entradas (ENT), Salidas (SAL) y tickets (TCK) a 0
--    - El contador de cada familia (consecutivo_familia) a 0, para que el
--      próximo artículo de cada familia vuelva a empezar en "001"
--
--  NO se tocan (quedan exactamente como están):
--    - familias, terceros (proveedores), colores, tallas, generos
--    - usuarios y sus roles
--    - periodos_bloqueados (los meses que ya cerraste siguen cerrados)
--
--  Si tienes dudas sobre si algún artículo es real y no de prueba, NO
--  ejecutes este script — pídeme en su lugar un borrado selectivo.
-- ============================================================================

delete from venta_items where true;
delete from ventas where true;
delete from historial_movimientos where true;
delete from productos where true;

update consecutivos set ultimo = 0 where tipo in ('ENT', 'SAL', 'TCK');
update familias set consecutivo_familia = 0 where true;

-- ============================================================================
-- Fin del reinicio. El catálogo de artículos y el kardex quedan vacíos.
-- ============================================================================
