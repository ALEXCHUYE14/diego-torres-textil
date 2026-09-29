-- ============================================================================
--  DIEGO TORRES · Migración 005 — Catálogo real del negocio
--  Ejecutar en el SQL Editor de Supabase, en cualquier momento después de
--  migration_004_rediseno_operativo.sql. Es segura de correr sin importar si
--  ya ejecutaste antes las familias/colores de ejemplo: usa ON CONFLICT, así
--  que no duplica ni falla si algo ya existe.
--
--  Reemplaza el catálogo de ejemplo (BATA, POLO, JEAN...) por las familias y
--  colores reales que indicaste. "PATALON" se guardó como "PANTALON" — si
--  era literal, dímelo y lo corrijo.
--
--  Nota: las familias de ejemplo (código '01000'..'15000', con cero a la
--  izquierda) NO chocan con las tuyas ('1000'..'20000', sin cero a la
--  izquierda) porque el código es texto y son valores distintos. Si quieres
--  que borre las de ejemplo, dímelo — no las elimino solo por si ya hay
--  artículos creados con ellas.
-- ============================================================================

insert into familias (codigo, nombre) values
  ('1000',  'BIOSEGURIDAD'),
  ('2000',  'BLUSA'),
  ('3000',  'BUSO'),
  ('4000',  'CACHUCHA'),
  ('5000',  'CAFETERIA'),
  ('6000',  'CALZADO'),
  ('7000',  'CAMISA'),
  ('8000',  'CAMISETA'),
  ('9000',  'CHALECOS'),
  ('10000', 'CHAQUETAS'),
  ('11000', 'COFIA'),
  ('12000', 'CONJUNTO'),
  ('13000', 'EPP'),
  ('14000', 'FERRETERIA'),
  ('15000', 'OVEROL'),
  ('16000', 'PAPELERIA'),
  ('17000', 'PANTALON'),
  ('18000', 'TECNOLOGIA'),
  ('19000', 'VARIOS'),
  ('20000', 'MATERIAS PRIMAS')
on conflict (codigo) do update set nombre = excluded.nombre;

insert into colores (nombre) values
  ('SIN-DEFINIR'), ('NEGRO(a)'), ('BLANCO(a)'), ('ROJO(a)'), ('CAFÉ'), ('AZUL'),
  ('AMARILLO(a)'), ('MORADO(a)'), ('NARANJA'), ('VERDE'), ('ROSADO'), ('GRIS'),
  ('INDIGO'), ('NAVI'), ('BICOLOR'), ('CAQUI'), ('BEIGE')
on conflict (nombre) do nothing;

-- ============================================================================
-- Fin de la migración 005.
-- ============================================================================
