-- ============================================================================
--  DIEGO TORRES · Migración 015 — Corrige el backfill defectuoso de
--  fecha_creacion (bug reportado: "Fecha de registro" mostraba 28/02/2026,
--  31/05/2026, etc. en vez de fechas de julio/agosto 2026).
--  Ejecutar en el SQL Editor de Supabase después de la migración 014.
--  Segura de volver a ejecutar: si ya se aplicó, no encuentra filas para
--  corregir y no hace nada (ver el WHERE de la actualización, abajo).
--
--  Causa raíz (bug propio de la primera versión de la migración 014):
--  Esa versión rellenaba `fecha_creacion` copiando `fecha_registro` para
--  todos los movimientos ya existentes. Eso está mal por dos motivos:
--   1) `fecha_registro` es la fecha CONTABLE del movimiento (ej. 01/03/2026
--      para la carga inicial de inventario), casi siempre muy anterior a
--      cuándo se digitó de verdad ese movimiento — aquí, en producción,
--      desde julio 2026 en adelante.
--   2) `fecha_registro` se guarda como medianoche UTC EXPLÍCITA de un día
--      de calendario (no es un instante real), pero `fecha_creacion` se
--      muestra en el frontend con fechaSegura(), que lee en hora LOCAL:
--      medianoche UTC del 01/03/2026 cae, en hora de Colombia/Perú
--      (UTC-5), el 28/02/2026 a las 19:00 — de ahí el "28 de febrero" y el
--      "31 de mayo" reportados (un día antes de cada inicio de mes).
--
--  Corrección: para cada fila cuyo fecha_creacion quedó igual a
--  fecha_registro (huella exacta del backfill defectuoso — un INSERT real
--  nunca cae justo en la medianoche UTC del día contable, así que esta
--  condición no toca ninguna fila digitada normalmente), se reemplaza por
--  el instante en que se corre ESTA migración: no se puede recuperar el
--  instante real en que se digitó cada movimiento histórico (nunca se
--  guardó), pero al menos deja de mostrar fechas de febrero/marzo/mayo que
--  se sabe con certeza que están mal, y todas las filas corregidas quedan
--  fechadas hoy (posterior al inicio de producción del sistema).
-- ============================================================================

update historial_movimientos
set fecha_creacion = now()
where fecha_creacion = fecha_registro;

-- ============================================================================
-- Fin de la migración 015.
-- ============================================================================
