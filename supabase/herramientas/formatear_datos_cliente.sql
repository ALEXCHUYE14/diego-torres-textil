-- ============================================================================
--  DIEGO TORRES · Formatear datos para entregar el sistema al cliente
--  Ejecutar en el SQL Editor de Supabase.
--
--  ⚠️ ACCIÓN DESTRUCTIVA E IRREVERSIBLE ⚠️
--  Genere antes un "Respaldo Excel" desde Informe si quiere conservar algo.
--
--  BORRA todos los datos cargados (pruebas incluidas):
--    - Artículos (productos) y todo el kardex (historial_movimientos)
--    - Ventas y su detalle
--    - Proveedores (terceros) y clientes
--    - Meses cerrados (periodos_bloqueados)
--  REINICIA:
--    - Consecutivos de documentos ENT / SAL / TCK → el próximo es ...000000001
--    - Contador de artículos de cada familia → el próximo vuelve a "001"
--  CONSERVA (configuración necesaria para que el cliente cargue sus datos):
--    - Usuarios y sus roles (nadie pierde el acceso)
--    - Familias, géneros, colores y tallas
--
--  Todo corre en una sola transacción: si algo falla, no se borra nada.
--  Al final muestra cuántas filas quedan en cada tabla (todas deben dar 0).
-- ============================================================================

delete from venta_items         where true;
delete from ventas              where true;
delete from historial_movimientos where true;
delete from productos           where true;
delete from clientes            where true;
delete from terceros            where true;
delete from periodos_bloqueados where true;

update consecutivos set ultimo = 0 where tipo in ('ENT', 'SAL', 'TCK');
update familias set consecutivo_familia = 0 where true;

-- Verificación: todas las cantidades deben ser 0 (y los consecutivos en 0).
select 'productos' as tabla, count(*) as filas from productos
union all select 'historial_movimientos', count(*) from historial_movimientos
union all select 'ventas', count(*) from ventas
union all select 'venta_items', count(*) from venta_items
union all select 'terceros (proveedores)', count(*) from terceros
union all select 'clientes', count(*) from clientes
union all select 'periodos_bloqueados', count(*) from periodos_bloqueados
union all select 'consecutivos (suma)', coalesce(sum(ultimo), 0) from consecutivos;
