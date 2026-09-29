-- ============================================================================
--  DIEGO TORRES · ACTUALIZAR BASE DE DATOS (archivo único)
--
--  Lleva la base al estado final del sistema (equivale a las migraciones
--  002 a 016), sin importar cuáles ya se hayan ejecutado antes. Se puede
--  volver a ejecutar todas las veces que haga falta sin dañar datos.
--
--  CUÁNDO USARLO
--   · Base existente (ya en uso): ejecute SOLO este archivo.
--   · Base nueva: ejecute primero schema.sql y después este archivo.
--
--  Se ejecuta completo como una sola transacción: si algo falla, no se
--  aplica nada.
--
--  Diferencias con correr las migraciones sueltas, para que sea seguro repetirlo:
--   · NO reinicia los consecutivos de documentos ENT/SAL (la 004 los ponía en 0
--     y volver a correrla duplicaba números de documento).
--   · Promueve Operativo → Administrador (migración 007) solo si todavía no
--     existe ningún Administrador; de lo contrario no toca los roles.
--   · No incluye la 005 (catálogo de familias/colores reales): es solo datos
--     y re-ejecutarla sobrescribiría nombres de familias editados.
--   · Deshace lo que deja una re-ejecución accidental de la 002/003
--     (funciones antiguas y cierre de mes para el rol equivocado).
--
--  Generado a partir de supabase/historial_migraciones/migration_0XX_*.sql.
-- ============================================================================

do $$
begin
  if to_regclass('public.productos') is null then
    raise exception 'La base está vacía: ejecute primero schema.sql y después este archivo.';
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- Base de la migración 002 · tabla de cierre de mes (idempotente)
-- ----------------------------------------------------------------------------
create table if not exists periodos_bloqueados (
  anio_mes      date primary key,
  bloqueado_por uuid references auth.users(id),
  bloqueado_en  timestamptz not null default now(),
  nota          text
);
alter table periodos_bloqueados enable row level security;
drop policy if exists sel_periodos_bloqueados on periodos_bloqueados;
create policy sel_periodos_bloqueados on periodos_bloqueados
  for select to authenticated using (true);


-- ############################################################################
--  migration_004_rediseno_operativo.sql
-- ############################################################################
-- ============================================================================
--  DIEGO TORRES · Migración 004 — Rediseño operativo mayor
--  Ejecutar completo en el SQL Editor de Supabase, DESPUÉS de schema.sql,
--  migration_002_cierre_mes_y_ajustes.sql y migration_003_articulos_sin_duplicados.sql.
--
--  Incluye:
--   1. Tablas maestras editables: generos, colores, tallas (con RLS)
--   2. productos: genero/color/talla pasan a ser OPCIONALES
--   3. Índice único de no-duplicados (migration_003) actualizado para tolerar NULL
--   4. rpc_crear_articulo: parámetros opcionales, codigo_barra sin segmentos vacíos
--   5. Trigger: bloquea eliminar (activo=false) un artículo con movimientos
--   6. historial_movimientos: columna documento_numero (maestro-detalle)
--   7. rpc_registrar_entrada_lote / rpc_registrar_salida_lote (multilínea)
--   8. Fecha mínima de movimientos: 01/03/2026 (ya no limitado al "mes actual")
--   9. rpc_obtener_documento: reescrito para documentos multilínea
--  10. rpc_importar_articulo_inicial: carga masiva de CATÁLOGO (código propio +
--      saldo inicial). Distinto de una entrada: es carga de inventario base,
--      no un movimiento del día a día — la carga masiva de movimientos
--      (Entradas/Salidas) queda deliberadamente fuera de este sistema.
--  11. (Opcional) reinicio de consecutivos ENT/SAL a 01 — leer advertencia
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. TABLAS MAESTRAS · generos, colores, tallas
-- ----------------------------------------------------------------------------
create table if not exists generos (
  id_genero uuid primary key default gen_random_uuid(),
  nombre    text not null unique,
  activo    boolean not null default true,
  creado_en timestamptz not null default now()
);

create table if not exists colores (
  id_color  uuid primary key default gen_random_uuid(),
  nombre    text not null unique,
  activo    boolean not null default true,
  creado_en timestamptz not null default now()
);

create table if not exists tallas (
  id_talla  uuid primary key default gen_random_uuid(),
  nombre    text not null unique,
  activo    boolean not null default true,
  creado_en timestamptz not null default now()
);

insert into generos (nombre) values ('HOMBRE'),('MUJER'),('UNISEX'),('NINO'),('NINA')
  on conflict (nombre) do nothing;
insert into tallas (nombre) values ('XS'),('S'),('M'),('L'),('XL'),('XXL'),('UNICA')
  on conflict (nombre) do nothing;
insert into colores (nombre) values
  ('AZUL'),('NEGRO'),('BLANCO'),('GRIS'),('BEIGE'),('VERDE'),('ROJO'),
  ('CELESTE'),('PLOMO'),('CREMA'),('AZUL MARINO'),('VINO')
  on conflict (nombre) do nothing;

alter table generos enable row level security;
alter table colores enable row level security;
alter table tallas  enable row level security;

do $$
declare t text;
begin
  foreach t in array array['generos','colores','tallas'] loop
    execute format('drop policy if exists sel_%s on %s', t, t);
    execute format('create policy sel_%s on %s for select to authenticated using (true)', t, t);
    execute format('drop policy if exists ins_%s on %s', t, t);
    execute format('create policy ins_%s on %s for insert to authenticated with check (fn_rol_actual() = ''operativo'')', t, t);
    execute format('drop policy if exists upd_%s on %s', t, t);
    execute format('create policy upd_%s on %s for update to authenticated using (fn_rol_actual() = ''operativo'')', t, t);
    execute format('drop policy if exists del_%s on %s', t, t);
    execute format('create policy del_%s on %s for delete to authenticated using (fn_rol_actual() = ''operativo'')', t, t);
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 2. productos · genero/color/talla ahora OPCIONALES
--    (se buscan y eliminan los CHECK existentes de forma dinámica: más
--    robusto que adivinar el nombre autogenerado por Postgres)
-- ----------------------------------------------------------------------------
alter table productos alter column genero drop not null;
alter table productos alter column color  drop not null;
alter table productos alter column talla  drop not null;

do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'productos'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%genero%'
  loop
    execute format('alter table productos drop constraint %I', c.conname);
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 3. Índice único de no-duplicados · reemplaza el de migration_003 para que
--    tolere NULL correctamente (SQL trata NULL <> NULL, así que sin el
--    coalesce dos artículos "solo nombre" del mismo tipo no se detectarían
--    como duplicados).
-- ----------------------------------------------------------------------------
drop index if exists uq_productos_atributos_activos;
create unique index uq_productos_atributos_activos
  on productos (id_familia, nombre, coalesce(genero,''), coalesce(color,''), coalesce(talla,''))
  where activo;

-- ----------------------------------------------------------------------------
-- 4. rpc_crear_articulo · genero/color/talla opcionales, código sin segmentos
--    vacíos (ej. "13000-004-EXTINTOR MARCA CHAFLUE" sin guiones colgantes)
-- ----------------------------------------------------------------------------
create or replace function rpc_crear_articulo(
  p_id_familia    uuid,
  p_nombre        text,
  p_genero        text default null,
  p_color         text default null,
  p_talla         text default null,
  p_valor_inicial numeric default 0,
  p_precio_venta  numeric default 0
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fam      familias%rowtype;
  v_codigo   text;
  v_producto productos%rowtype;
  v_nombre   text := upper(trim(p_nombre));
  v_genero   text := nullif(upper(trim(coalesce(p_genero, ''))), '');
  v_color    text := nullif(upper(trim(coalesce(p_color, ''))), '');
  v_talla    text := nullif(upper(trim(coalesce(p_talla, ''))), '');
  v_partes   text[];
begin
  if fn_rol_actual() <> 'operativo' then
    raise exception 'Permiso denegado: se requiere rol Operativo';
  end if;
  if v_nombre = '' then
    raise exception 'El nombre es obligatorio';
  end if;

  -- Camino rápido: reutiliza el artículo activo si ya existe uno idéntico
  select * into v_producto from productos
  where id_familia = p_id_familia and activo
    and nombre = v_nombre
    and coalesce(genero,'') = coalesce(v_genero,'')
    and coalesce(color,'')  = coalesce(v_color,'')
    and coalesce(talla,'')  = coalesce(v_talla,'')
  limit 1;
  if found then
    return json_build_object('id_producto', v_producto.id_producto, 'codigo_barra', v_producto.codigo_barra, 'ya_existia', true);
  end if;

  select * into v_fam from familias where id_familia = p_id_familia for update;
  if not found then raise exception 'Familia no encontrada'; end if;

  update familias set consecutivo_familia = consecutivo_familia + 1
  where id_familia = p_id_familia
  returning * into v_fam;

  v_partes := array[v_fam.codigo, lpad(v_fam.consecutivo_familia::text, 3, '0'), v_nombre];
  if v_genero is not null then v_partes := v_partes || v_genero; end if;
  if v_color  is not null then v_partes := v_partes || v_color;  end if;
  if v_talla  is not null then v_partes := v_partes || v_talla;  end if;
  v_codigo := array_to_string(v_partes, '-');

  begin
    insert into productos (codigo_barra, nombre, genero, color, talla, id_familia,
      valor_unitario_inicial, ultimo_valor_unitario, costo_promedio_ponderado, precio_venta)
    values (v_codigo, v_nombre, v_genero, v_color, v_talla, p_id_familia,
      p_valor_inicial, p_valor_inicial, p_valor_inicial, p_precio_venta)
    returning * into v_producto;
  exception when unique_violation then
    select * into v_producto from productos
    where id_familia = p_id_familia and activo
      and nombre = v_nombre
      and coalesce(genero,'') = coalesce(v_genero,'')
      and coalesce(color,'')  = coalesce(v_color,'')
      and coalesce(talla,'')  = coalesce(v_talla,'')
    limit 1;
    if not found then raise; end if;
    return json_build_object('id_producto', v_producto.id_producto, 'codigo_barra', v_producto.codigo_barra, 'ya_existia', true);
  end;

  return json_build_object('id_producto', v_producto.id_producto, 'codigo_barra', v_producto.codigo_barra, 'ya_existia', false);
end $$;

-- ----------------------------------------------------------------------------
-- 5. Trigger · bloquea eliminar (soft-delete) un artículo con movimientos
-- ----------------------------------------------------------------------------
create or replace function fn_bloquear_eliminacion_con_movimientos()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.activo = false and old.activo = true then
    if exists (select 1 from historial_movimientos where producto_id = old.id_producto) then
      raise exception 'No se puede eliminar: el artículo % ya tiene movimientos registrados en el kardex', old.codigo_barra;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_bloquear_eliminacion on productos;
create trigger trg_bloquear_eliminacion
before update on productos
for each row execute function fn_bloquear_eliminacion_con_movimientos();

-- ----------------------------------------------------------------------------
-- 6. historial_movimientos · documento_numero (agrupa varias líneas bajo un
--    mismo número de documento maestro-detalle). Se respalda con las filas
--    existentes: cada movimiento antiguo pasa a ser "documento de 1 línea".
-- ----------------------------------------------------------------------------
alter table historial_movimientos add column if not exists documento_numero text;
update historial_movimientos set documento_numero = tipo_consecutivo where documento_numero is null;
alter table historial_movimientos alter column documento_numero set not null;
create index if not exists idx_mov_documento_numero on historial_movimientos (documento_numero);

-- ----------------------------------------------------------------------------
-- 7. RPC · ENTRADA multilínea (maestro-detalle transaccional)
--    p_items: [{ "producto_id": uuid, "cantidad": numeric, "valor_unitario": numeric }, ...]
-- ----------------------------------------------------------------------------
create or replace function rpc_registrar_entrada_lote(
  p_fecha           date,
  p_tipo_movimiento text,
  p_proveedor_id    uuid,
  p_items           jsonb,
  p_nro_factura     text default null,
  p_nro_orden       text default null,
  p_concepto        text default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item        jsonb;
  v_prod        productos%rowtype;
  v_doc         text;
  v_linea       int := 0;
  v_fecha       timestamptz;
  v_cant        numeric;
  v_valor       numeric;
  v_nuevo_stock numeric;
  v_nuevo_cpp   numeric;
  v_lineas      json[] := array[]::json[];
begin
  if fn_rol_actual() <> 'operativo' then
    raise exception 'Permiso denegado: se requiere rol Operativo';
  end if;
  if p_tipo_movimiento not in ('1000','1002','1007','1210') then
    raise exception 'Tipo de movimiento de entrada no autorizado';
  end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'La entrada no tiene artículos';
  end if;

  v_fecha := p_fecha::timestamptz;
  if v_fecha::date < date '2026-03-01' then
    raise exception 'La fecha no puede ser anterior al 01/03/2026 (inicio de operación del sistema)';
  end if;
  if v_fecha::date > current_date then
    raise exception 'La fecha no puede ser posterior a hoy';
  end if;
  perform fn_verificar_periodo_abierto(v_fecha);

  v_doc := fn_siguiente_consecutivo('ENT');

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_linea := v_linea + 1;
    v_cant  := (v_item->>'cantidad')::numeric;
    v_valor := (v_item->>'valor_unitario')::numeric;
    if v_cant is null or v_cant <= 0 then
      raise exception 'Línea %: la cantidad debe ser mayor a 0', v_linea;
    end if;
    if v_valor is null or v_valor < 0 then
      raise exception 'Línea %: el valor unitario no puede ser negativo', v_linea;
    end if;

    select * into v_prod from productos
    where id_producto = (v_item->>'producto_id')::uuid for update;
    if not found then
      raise exception 'Línea %: producto no encontrado', v_linea;
    end if;

    v_nuevo_stock := v_prod.stock_real + v_cant;
    v_nuevo_cpp := case when v_nuevo_stock = 0 then v_valor
      else round(((v_prod.stock_real * v_prod.costo_promedio_ponderado) + (v_cant * v_valor)) / v_nuevo_stock, 4) end;

    update productos set
      stock_real = v_nuevo_stock,
      costo_promedio_ponderado = v_nuevo_cpp,
      ultimo_valor_unitario = v_valor
    where id_producto = v_prod.id_producto;

    insert into historial_movimientos (tipo_consecutivo, documento_numero, tipo_movimiento, naturaleza,
      fecha_registro, producto_id, cantidad, valor_unitario, valor_total,
      proveedor_id, nro_factura, nro_orden, concepto, usuario_id, stock_resultante)
    values (v_doc || '-' || lpad(v_linea::text, 2, '0'), v_doc, p_tipo_movimiento, 'ENTRADA', v_fecha,
      v_prod.id_producto, v_cant, v_valor, round(v_cant * v_valor, 2),
      p_proveedor_id, p_nro_factura, p_nro_orden, p_concepto, auth.uid(), v_nuevo_stock);

    v_lineas := v_lineas || json_build_object('producto', v_prod.nombre, 'cantidad', v_cant, 'nuevo_stock', v_nuevo_stock);
  end loop;

  return json_build_object('documento', v_doc, 'lineas', v_linea, 'detalle', array_to_json(v_lineas));
end $$;

-- ----------------------------------------------------------------------------
-- 8. RPC · SALIDA multilínea (maestro-detalle transaccional)
--    p_items: [{ "producto_id": uuid, "cantidad": numeric }, ...]
--    valor_unitario siempre es el CPP vigente del producto (solo lectura).
-- ----------------------------------------------------------------------------
create or replace function rpc_registrar_salida_lote(
  p_fecha           date,
  p_tipo_movimiento text,
  p_items           jsonb,
  p_proveedor_id    uuid default null,
  p_concepto        text default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item        jsonb;
  v_prod        productos%rowtype;
  v_doc         text;
  v_linea       int := 0;
  v_fecha       timestamptz;
  v_cant        numeric;
  v_nuevo_stock numeric;
  v_lineas      json[] := array[]::json[];
begin
  if fn_rol_actual() <> 'operativo' then
    raise exception 'Permiso denegado: se requiere rol Operativo';
  end if;
  if p_tipo_movimiento not in ('2000','2003') then
    raise exception 'Tipo de movimiento de salida no autorizado';
  end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'La salida no tiene artículos';
  end if;

  v_fecha := p_fecha::timestamptz;
  if v_fecha::date < date '2026-03-01' then
    raise exception 'La fecha no puede ser anterior al 01/03/2026 (inicio de operación del sistema)';
  end if;
  if v_fecha::date > current_date then
    raise exception 'La fecha no puede ser posterior a hoy';
  end if;
  perform fn_verificar_periodo_abierto(v_fecha);

  v_doc := fn_siguiente_consecutivo('SAL');

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_linea := v_linea + 1;
    v_cant := (v_item->>'cantidad')::numeric;
    if v_cant is null or v_cant <= 0 then
      raise exception 'Línea %: la cantidad debe ser mayor a 0', v_linea;
    end if;

    select * into v_prod from productos
    where id_producto = (v_item->>'producto_id')::uuid for update;
    if not found then
      raise exception 'Línea %: producto no encontrado', v_linea;
    end if;
    if v_cant > v_prod.stock_real then
      raise exception 'Línea % (%): STOCK_INSUFICIENTE — disponible %, solicitado %', v_linea, v_prod.nombre, v_prod.stock_real, v_cant;
    end if;

    v_nuevo_stock := v_prod.stock_real - v_cant;
    update productos set stock_real = v_nuevo_stock where id_producto = v_prod.id_producto;

    insert into historial_movimientos (tipo_consecutivo, documento_numero, tipo_movimiento, naturaleza,
      fecha_registro, producto_id, cantidad, valor_unitario, valor_total,
      proveedor_id, concepto, usuario_id, stock_resultante)
    values (v_doc || '-' || lpad(v_linea::text, 2, '0'), v_doc, p_tipo_movimiento, 'SALIDA', v_fecha,
      v_prod.id_producto, v_cant, v_prod.costo_promedio_ponderado, round(v_cant * v_prod.costo_promedio_ponderado, 2),
      p_proveedor_id, p_concepto, auth.uid(), v_nuevo_stock);

    v_lineas := v_lineas || json_build_object('producto', v_prod.nombre, 'cantidad', v_cant, 'nuevo_stock', v_nuevo_stock);
  end loop;

  return json_build_object('documento', v_doc, 'lineas', v_linea, 'detalle', array_to_json(v_lineas));
end $$;

-- ----------------------------------------------------------------------------
-- 9. rpc_obtener_documento · reescrito para documentos multilínea. Funciona
--    tanto para documentos nuevos (varias líneas) como para movimientos
--    antiguos de una sola línea (documento_numero = tipo_consecutivo, ya
--    respaldado en el paso 6). La rama de FACTURA_VENTA se retira: el módulo
--    de impresión ahora solo maneja Entrada y Salida de almacén.
-- ----------------------------------------------------------------------------
create or replace function rpc_obtener_documento(p_tipo text, p_numero text)
returns json
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_cabecera historial_movimientos%rowtype;
  v_doc      json;
begin
  select * into v_cabecera from historial_movimientos
  where documento_numero = p_numero
  order by tipo_consecutivo
  limit 1;
  if not found then return null; end if;

  select json_build_object(
    'documento_numero', v_cabecera.documento_numero,
    'fecha_registro', v_cabecera.fecha_registro,
    'tipo_movimiento', v_cabecera.tipo_movimiento,
    'naturaleza', v_cabecera.naturaleza,
    'proveedor', (select row_to_json(ter) from terceros ter where ter.id_proveedor = v_cabecera.proveedor_id),
    'usuario_nombre', (select nombre from usuarios where id_usuario = v_cabecera.usuario_id),
    'items', (
      select coalesce(json_agg(json_build_object(
        'fecha_registro', m.fecha_registro,
        'tipo_movimiento', m.tipo_movimiento,
        'naturaleza', m.naturaleza,
        'producto_nombre', p.nombre,
        'proveedor_nombre', ter.razon_social,
        'cantidad', m.cantidad,
        'valor_unitario', m.valor_unitario,
        'valor_total', m.valor_total
      ) order by m.tipo_consecutivo), '[]'::json)
      from historial_movimientos m
      join productos p on p.id_producto = m.producto_id
      left join terceros ter on ter.id_proveedor = m.proveedor_id
      where m.documento_numero = p_numero
    ),
    'total', (select coalesce(sum(valor_total), 0) from historial_movimientos where documento_numero = p_numero),
    'cantidad_total', (select coalesce(sum(cantidad), 0) from historial_movimientos where documento_numero = p_numero)
  ) into v_doc;

  return v_doc;
end $$;

-- ----------------------------------------------------------------------------
-- 10. RPC · carga masiva de CATÁLOGO con código propio y saldo inicial.
--     A diferencia de rpc_crear_articulo, aquí el código de barras lo trae
--     el archivo (no se genera por consecutivo de familia) porque se asume
--     que ya son códigos existentes del inventario físico. Si trae saldo
--     inicial > 0, se registra como una entrada de ajuste con fecha
--     01/03/2026 (fecha de arranque del sistema), para que quede en el
--     kardex y no rompa el principio de "todo cambio de stock tiene un
--     movimiento asociado".
-- ----------------------------------------------------------------------------
create or replace function rpc_importar_articulo_inicial(
  p_codigo_barra  text,
  p_nombre        text,
  p_id_familia    uuid,
  p_genero        text default null,
  p_color         text default null,
  p_talla         text default null,
  p_saldo_inicial numeric default 0,
  p_valor_inicial numeric default 0
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
  v_consecutivo text;
begin
  if fn_rol_actual() <> 'operativo' then
    raise exception 'Permiso denegado: se requiere rol Operativo';
  end if;
  if v_codigo = '' then raise exception 'El código del producto es obligatorio'; end if;
  if v_nombre = '' then raise exception 'El nombre es obligatorio'; end if;
  if p_saldo_inicial < 0 then raise exception 'El saldo inicial no puede ser negativo'; end if;
  if p_valor_inicial < 0 then raise exception 'El valor inicial no puede ser negativo'; end if;

  insert into productos (codigo_barra, nombre, genero, color, talla, id_familia,
    valor_unitario_inicial, ultimo_valor_unitario, costo_promedio_ponderado, stock_real, precio_venta)
  values (v_codigo, v_nombre, v_genero, v_color, v_talla, p_id_familia,
    p_valor_inicial, p_valor_inicial, p_valor_inicial, 0, 0)
  returning * into v_producto;

  if p_saldo_inicial > 0 then
    v_consecutivo := fn_siguiente_consecutivo('ENT');
    update productos set stock_real = p_saldo_inicial where id_producto = v_producto.id_producto;

    insert into historial_movimientos (tipo_consecutivo, documento_numero, tipo_movimiento, naturaleza,
      fecha_registro, producto_id, cantidad, valor_unitario, valor_total, concepto, usuario_id, stock_resultante)
    values (v_consecutivo, v_consecutivo, '1007', 'ENTRADA', date '2026-03-01',
      v_producto.id_producto, p_saldo_inicial, p_valor_inicial, round(p_saldo_inicial * p_valor_inicial, 2),
      'Saldo inicial · carga masiva de catálogo', auth.uid(), p_saldo_inicial);
  end if;

  return json_build_object('id_producto', v_producto.id_producto, 'codigo_barra', v_producto.codigo_barra);
end $$;

-- ----------------------------------------------------------------------------
-- 11. (OPCIONAL) Reiniciar consecutivos ENT/SAL para que el próximo documento
--     sea "0000001" — tal como pediste.
--
--     ADVERTENCIA: si ya guardaste entradas o salidas de PRUEBA (por ejemplo
--     al probar la carga masiva anterior), esas filas ya usaron números como
--     ENT000000001, ENT000000002, etc. Si reinicias el contador, el PRIMER
--     documento nuevo que grabes después de esto intentará reutilizar ese
--     mismo número y la base de datos lo RECHAZARÁ (no se duplica ni se
--     corrompe nada — simplemente ese guardado fallará con un error claro y
--     tendrás que intentarlo de nuevo, momento en el cual ya tomará el
--     siguiente número libre).
--
--     Si prefieres evitar cualquier fricción, comenta estas dos líneas y deja
--     que el contador continúe donde esté.
-- ----------------------------------------------------------------------------
-- (Omitido en actualizar_base.sql: reiniciar consecutivos duplicaría números de documento.)

-- ============================================================================
-- Fin de la migración 004.
-- ============================================================================


-- ############################################################################
--  migration_006_fix_zona_horaria.sql
-- ############################################################################
-- ============================================================================
--  DIEGO TORRES · Migración 006 — Corrección crítica de zona horaria
--  Ejecutar en el SQL Editor de Supabase después de las migraciones 003-005.
--
--  Diagnóstico del bug:
--  Al registrar una entrada/salida con fecha "01/03/2026", el frontend envía
--  la fecha como texto plano 'YYYY-MM-DD' (correcto, sin problema ahí). El
--  problema estaba en el servidor: las funciones convertían esa fecha a
--  timestamptz con un cast implícito (`p_fecha::timestamptz`), que depende
--  de la zona horaria de la SESIÓN de Postgres para decidir qué instante es
--  "medianoche" de ese día. Si esa sesión no está en UTC de forma explícita,
--  o cuando el navegador del usuario (en una zona horaria detrás de UTC,
--  como Colombia/Perú) vuelve a convertir ese instante a su hora local para
--  mostrarlo, el resultado se corre un día hacia atrás — exactamente el
--  síntoma reportado: "01 de marzo" se guardaba/mostraba como "28 de
--  febrero", y por eso el bloqueo de mes activaba febrero en vez de marzo.
--
--  Solución:
--   1. fn_verificar_periodo_abierto ahora recibe DATE (no timestamptz) y
--      hace toda la comparación en aritmética de fechas puras, sin ninguna
--      conversión de zona horaria de por medio — cero ambigüedad posible.
--   2. rpc_registrar_entrada_lote / rpc_registrar_salida_lote construyen el
--      timestamp de forma EXPLÍCITA en UTC con make_timestamptz(...,'UTC'),
--      sin depender de la configuración de la sesión, y pasan la fecha
--      original (date) al chequeo de mes bloqueado en vez del timestamp ya
--      convertido.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. fn_verificar_periodo_abierto · ahora trabaja con DATE, no timestamptz
-- ----------------------------------------------------------------------------
create or replace function fn_verificar_periodo_abierto(p_fecha date)
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
-- 2. rpc_registrar_entrada_lote · fecha construida explícitamente en UTC +
--    verificación de período con la fecha original (date), sin conversión
-- ----------------------------------------------------------------------------
create or replace function rpc_registrar_entrada_lote(
  p_fecha           date,
  p_tipo_movimiento text,
  p_proveedor_id    uuid,
  p_items           jsonb,
  p_nro_factura     text default null,
  p_nro_orden       text default null,
  p_concepto        text default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item        jsonb;
  v_prod        productos%rowtype;
  v_doc         text;
  v_linea       int := 0;
  v_fecha_ts    timestamptz;
  v_cant        numeric;
  v_valor       numeric;
  v_nuevo_stock numeric;
  v_nuevo_cpp   numeric;
  v_lineas      json[] := array[]::json[];
begin
  if fn_rol_actual() <> 'operativo' then
    raise exception 'Permiso denegado: se requiere rol Operativo';
  end if;
  if p_tipo_movimiento not in ('1000','1002','1007','1210') then
    raise exception 'Tipo de movimiento de entrada no autorizado';
  end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'La entrada no tiene artículos';
  end if;

  if p_fecha < date '2026-03-01' then
    raise exception 'La fecha no puede ser anterior al 01/03/2026 (inicio de operación del sistema)';
  end if;
  if p_fecha > current_date then
    raise exception 'La fecha no puede ser posterior a hoy';
  end if;
  -- Se verifica con la fecha original (date), sin pasar por ninguna
  -- conversión de zona horaria: cero riesgo de desfase de un día.
  perform fn_verificar_periodo_abierto(p_fecha);

  -- Instante guardado en el kardex: medianoche UTC explícita del día
  -- elegido, construida sin depender de la zona horaria de la sesión.
  v_fecha_ts := make_timestamptz(
    extract(year from p_fecha)::int, extract(month from p_fecha)::int, extract(day from p_fecha)::int,
    0, 0, 0, 'UTC'
  );

  v_doc := fn_siguiente_consecutivo('ENT');

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_linea := v_linea + 1;
    v_cant  := (v_item->>'cantidad')::numeric;
    v_valor := (v_item->>'valor_unitario')::numeric;
    if v_cant is null or v_cant <= 0 then
      raise exception 'Línea %: la cantidad debe ser mayor a 0', v_linea;
    end if;
    if v_valor is null or v_valor < 0 then
      raise exception 'Línea %: el valor unitario no puede ser negativo', v_linea;
    end if;

    select * into v_prod from productos
    where id_producto = (v_item->>'producto_id')::uuid for update;
    if not found then
      raise exception 'Línea %: producto no encontrado', v_linea;
    end if;

    v_nuevo_stock := v_prod.stock_real + v_cant;
    v_nuevo_cpp := case when v_nuevo_stock = 0 then v_valor
      else round(((v_prod.stock_real * v_prod.costo_promedio_ponderado) + (v_cant * v_valor)) / v_nuevo_stock, 4) end;

    update productos set
      stock_real = v_nuevo_stock,
      costo_promedio_ponderado = v_nuevo_cpp,
      ultimo_valor_unitario = v_valor
    where id_producto = v_prod.id_producto;

    insert into historial_movimientos (tipo_consecutivo, documento_numero, tipo_movimiento, naturaleza,
      fecha_registro, producto_id, cantidad, valor_unitario, valor_total,
      proveedor_id, nro_factura, nro_orden, concepto, usuario_id, stock_resultante)
    values (v_doc || '-' || lpad(v_linea::text, 2, '0'), v_doc, p_tipo_movimiento, 'ENTRADA', v_fecha_ts,
      v_prod.id_producto, v_cant, v_valor, round(v_cant * v_valor, 2),
      p_proveedor_id, p_nro_factura, p_nro_orden, p_concepto, auth.uid(), v_nuevo_stock);

    v_lineas := v_lineas || json_build_object('producto', v_prod.nombre, 'cantidad', v_cant, 'nuevo_stock', v_nuevo_stock);
  end loop;

  return json_build_object('documento', v_doc, 'lineas', v_linea, 'detalle', array_to_json(v_lineas));
end $$;

-- ----------------------------------------------------------------------------
-- 3. rpc_registrar_salida_lote · mismo tratamiento explícito en UTC
-- ----------------------------------------------------------------------------
create or replace function rpc_registrar_salida_lote(
  p_fecha           date,
  p_tipo_movimiento text,
  p_items           jsonb,
  p_proveedor_id    uuid default null,
  p_concepto        text default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item        jsonb;
  v_prod        productos%rowtype;
  v_doc         text;
  v_linea       int := 0;
  v_fecha_ts    timestamptz;
  v_cant        numeric;
  v_nuevo_stock numeric;
  v_lineas      json[] := array[]::json[];
begin
  if fn_rol_actual() <> 'operativo' then
    raise exception 'Permiso denegado: se requiere rol Operativo';
  end if;
  if p_tipo_movimiento not in ('2000','2003') then
    raise exception 'Tipo de movimiento de salida no autorizado';
  end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'La salida no tiene artículos';
  end if;

  if p_fecha < date '2026-03-01' then
    raise exception 'La fecha no puede ser anterior al 01/03/2026 (inicio de operación del sistema)';
  end if;
  if p_fecha > current_date then
    raise exception 'La fecha no puede ser posterior a hoy';
  end if;
  perform fn_verificar_periodo_abierto(p_fecha);

  v_fecha_ts := make_timestamptz(
    extract(year from p_fecha)::int, extract(month from p_fecha)::int, extract(day from p_fecha)::int,
    0, 0, 0, 'UTC'
  );

  v_doc := fn_siguiente_consecutivo('SAL');

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_linea := v_linea + 1;
    v_cant := (v_item->>'cantidad')::numeric;
    if v_cant is null or v_cant <= 0 then
      raise exception 'Línea %: la cantidad debe ser mayor a 0', v_linea;
    end if;

    select * into v_prod from productos
    where id_producto = (v_item->>'producto_id')::uuid for update;
    if not found then
      raise exception 'Línea %: producto no encontrado', v_linea;
    end if;
    if v_cant > v_prod.stock_real then
      raise exception 'Línea % (%): STOCK_INSUFICIENTE — disponible %, solicitado %', v_linea, v_prod.nombre, v_prod.stock_real, v_cant;
    end if;

    v_nuevo_stock := v_prod.stock_real - v_cant;
    update productos set stock_real = v_nuevo_stock where id_producto = v_prod.id_producto;

    insert into historial_movimientos (tipo_consecutivo, documento_numero, tipo_movimiento, naturaleza,
      fecha_registro, producto_id, cantidad, valor_unitario, valor_total,
      proveedor_id, concepto, usuario_id, stock_resultante)
    values (v_doc || '-' || lpad(v_linea::text, 2, '0'), v_doc, p_tipo_movimiento, 'SALIDA', v_fecha_ts,
      v_prod.id_producto, v_cant, v_prod.costo_promedio_ponderado, round(v_cant * v_prod.costo_promedio_ponderado, 2),
      p_proveedor_id, p_concepto, auth.uid(), v_nuevo_stock);

    v_lineas := v_lineas || json_build_object('producto', v_prod.nombre, 'cantidad', v_cant, 'nuevo_stock', v_nuevo_stock);
  end loop;

  return json_build_object('documento', v_doc, 'lineas', v_linea, 'detalle', array_to_json(v_lineas));
end $$;

-- ============================================================================
-- Fin de la migración 006.
-- ============================================================================


-- ############################################################################
--  migration_007_rbac.sql
-- ############################################################################
-- ============================================================================
--  DIEGO TORRES · Migración 007 — Control de acceso basado en roles (RBAC)
--  Ejecutar en el SQL Editor de Supabase después de las migraciones 002-006.
--
--  Antes: 2 roles ('consulta' de solo lectura, 'operativo' con acceso total,
--  mostrado como "Administrador" solo en la interfaz — el valor real en la
--  base de datos seguía siendo 'operativo').
--
--  Ahora: 3 roles REALES en la base de datos:
--    - 'consulta'      → solo lectura en todo el sistema
--    - 'operativo'      → crear artículos, registrar entradas/salidas,
--                         consultar kardex. NO puede eliminar artículos ni
--                         gestionar usuarios ni cerrar/abrir meses.
--    - 'administrador' → todo lo anterior + eliminar artículos + gestión
--                         de usuarios + cierre de mes.
--
--  Los usuarios que HOY tienen rol 'operativo' (el antiguo "acceso total")
--  se migran automáticamente a 'administrador' para no perder de golpe sus
--  permisos actuales. 'operativo' pasa a ser, desde ahora, el rol limitado.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. usuarios.rol · admite el nuevo valor 'administrador'
-- ----------------------------------------------------------------------------
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'usuarios'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%rol%'
  loop
    execute format('alter table usuarios drop constraint %I', c.conname);
  end loop;
end $$;

alter table usuarios add constraint usuarios_rol_check
  check (rol in ('consulta', 'operativo', 'administrador'));

-- Preserva el acceso total de quienes hoy son 'operativo' (el rol de acceso
-- total anterior): pasan a 'administrador', el nuevo rol de control total.
update usuarios set rol = 'administrador'
where rol = 'operativo'
  and not exists (select 1 from usuarios where rol = 'administrador');

-- Correo del usuario, para poder identificarlo en el panel de administración
-- (la tabla usuarios no lo tenía; solo vivía en auth.users).
alter table usuarios add column if not exists correo text;
update usuarios u set correo = au.email
from auth.users au
where au.id = u.id_usuario and u.correo is null;

create or replace function fn_nuevo_usuario()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.usuarios (id_usuario, nombre, correo, rol)
  values (new.id, coalesce(new.raw_user_meta_data->>'nombre', split_part(new.email,'@',1)), new.email, 'consulta')
  on conflict (id_usuario) do update set correo = excluded.correo;
  return new;
end $$;

-- ----------------------------------------------------------------------------
-- 2. Funciones auxiliares de permisos
-- ----------------------------------------------------------------------------
create or replace function fn_puede_escribir()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select fn_rol_actual() in ('operativo', 'administrador');
$$;

create or replace function fn_es_administrador()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select fn_rol_actual() = 'administrador';
$$;

-- ----------------------------------------------------------------------------
-- 3. RLS · las tablas operativas admiten escritura a Operativo Y Administrador
-- ----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['familias','productos','terceros','clientes',
    'historial_movimientos','ventas','venta_items','generos','colores','tallas'] loop
    execute format('drop policy if exists ins_%s on %s', t, t);
    execute format('create policy ins_%s on %s for insert to authenticated with check (fn_puede_escribir())', t, t);
    execute format('drop policy if exists upd_%s on %s', t, t);
    execute format('create policy upd_%s on %s for update to authenticated using (fn_puede_escribir())', t, t);
    execute format('drop policy if exists del_%s on %s', t, t);
    execute format('create policy del_%s on %s for delete to authenticated using (fn_puede_escribir())', t, t);
  end loop;
end $$;

-- periodos_bloqueados · cerrar/abrir un mes queda reservado al Administrador
drop policy if exists ins_periodos_bloqueados on periodos_bloqueados;
create policy ins_periodos_bloqueados on periodos_bloqueados
  for insert to authenticated with check (fn_es_administrador());
drop policy if exists del_periodos_bloqueados on periodos_bloqueados;
create policy del_periodos_bloqueados on periodos_bloqueados
  for delete to authenticated using (fn_es_administrador());

-- usuarios · un Administrador puede cambiar el rol/nombre de cualquier
-- usuario. La inserción del perfil nuevo la hace el trigger de registro
-- (fn_nuevo_usuario) o la Edge Function de creación de usuarios, ambas con
-- privilegios de servidor que no pasan por RLS.
drop policy if exists upd_usuarios on usuarios;
create policy upd_usuarios on usuarios
  for update to authenticated using (fn_es_administrador());

-- ----------------------------------------------------------------------------
-- 4. Trigger de borrado de artículos · ahora también exige Administrador,
--    además de seguir bloqueando si el artículo ya tiene movimientos.
-- ----------------------------------------------------------------------------
create or replace function fn_bloquear_eliminacion_con_movimientos()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.activo = false and old.activo = true then
    if not fn_es_administrador() then
      raise exception 'Permiso denegado: solo un Administrador puede eliminar artículos';
    end if;
    if exists (select 1 from historial_movimientos where producto_id = old.id_producto) then
      raise exception 'No se puede eliminar: el artículo % ya tiene movimientos registrados en el kardex', old.codigo_barra;
    end if;
  end if;
  return new;
end $$;

-- ----------------------------------------------------------------------------
-- 5. RPCs operativas · Operativo Y Administrador (antes solo 'operativo')
-- ----------------------------------------------------------------------------
create or replace function rpc_crear_articulo(
  p_id_familia    uuid,
  p_nombre        text,
  p_genero        text default null,
  p_color         text default null,
  p_talla         text default null,
  p_valor_inicial numeric default 0,
  p_precio_venta  numeric default 0
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fam      familias%rowtype;
  v_codigo   text;
  v_producto productos%rowtype;
  v_nombre   text := upper(trim(p_nombre));
  v_genero   text := nullif(upper(trim(coalesce(p_genero, ''))), '');
  v_color    text := nullif(upper(trim(coalesce(p_color, ''))), '');
  v_talla    text := nullif(upper(trim(coalesce(p_talla, ''))), '');
  v_partes   text[];
begin
  if not fn_puede_escribir() then
    raise exception 'Permiso denegado: se requiere rol Operativo o Administrador';
  end if;
  if v_nombre = '' then
    raise exception 'El nombre es obligatorio';
  end if;

  select * into v_producto from productos
  where id_familia = p_id_familia and activo
    and nombre = v_nombre
    and coalesce(genero,'') = coalesce(v_genero,'')
    and coalesce(color,'')  = coalesce(v_color,'')
    and coalesce(talla,'')  = coalesce(v_talla,'')
  limit 1;
  if found then
    return json_build_object('id_producto', v_producto.id_producto, 'codigo_barra', v_producto.codigo_barra, 'ya_existia', true);
  end if;

  select * into v_fam from familias where id_familia = p_id_familia for update;
  if not found then raise exception 'Familia no encontrada'; end if;

  update familias set consecutivo_familia = consecutivo_familia + 1
  where id_familia = p_id_familia
  returning * into v_fam;

  v_partes := array[v_fam.codigo, lpad(v_fam.consecutivo_familia::text, 3, '0'), v_nombre];
  if v_genero is not null then v_partes := v_partes || v_genero; end if;
  if v_color  is not null then v_partes := v_partes || v_color;  end if;
  if v_talla  is not null then v_partes := v_partes || v_talla;  end if;
  v_codigo := array_to_string(v_partes, '-');

  begin
    insert into productos (codigo_barra, nombre, genero, color, talla, id_familia,
      valor_unitario_inicial, ultimo_valor_unitario, costo_promedio_ponderado, precio_venta)
    values (v_codigo, v_nombre, v_genero, v_color, v_talla, p_id_familia,
      p_valor_inicial, p_valor_inicial, p_valor_inicial, p_precio_venta)
    returning * into v_producto;
  exception when unique_violation then
    select * into v_producto from productos
    where id_familia = p_id_familia and activo
      and nombre = v_nombre
      and coalesce(genero,'') = coalesce(v_genero,'')
      and coalesce(color,'')  = coalesce(v_color,'')
      and coalesce(talla,'')  = coalesce(v_talla,'')
    limit 1;
    if not found then raise; end if;
    return json_build_object('id_producto', v_producto.id_producto, 'codigo_barra', v_producto.codigo_barra, 'ya_existia', true);
  end;

  return json_build_object('id_producto', v_producto.id_producto, 'codigo_barra', v_producto.codigo_barra, 'ya_existia', false);
end $$;

create or replace function rpc_importar_articulo_inicial(
  p_codigo_barra  text,
  p_nombre        text,
  p_id_familia    uuid,
  p_genero        text default null,
  p_color         text default null,
  p_talla         text default null,
  p_saldo_inicial numeric default 0,
  p_valor_inicial numeric default 0
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
  v_consecutivo text;
begin
  if not fn_puede_escribir() then
    raise exception 'Permiso denegado: se requiere rol Operativo o Administrador';
  end if;
  if v_codigo = '' then raise exception 'El código del producto es obligatorio'; end if;
  if v_nombre = '' then raise exception 'El nombre es obligatorio'; end if;
  if p_saldo_inicial < 0 then raise exception 'El saldo inicial no puede ser negativo'; end if;
  if p_valor_inicial < 0 then raise exception 'El valor inicial no puede ser negativo'; end if;

  insert into productos (codigo_barra, nombre, genero, color, talla, id_familia,
    valor_unitario_inicial, ultimo_valor_unitario, costo_promedio_ponderado, stock_real, precio_venta)
  values (v_codigo, v_nombre, v_genero, v_color, v_talla, p_id_familia,
    p_valor_inicial, p_valor_inicial, p_valor_inicial, 0, 0)
  returning * into v_producto;

  if p_saldo_inicial > 0 then
    v_consecutivo := fn_siguiente_consecutivo('ENT');
    update productos set stock_real = p_saldo_inicial where id_producto = v_producto.id_producto;

    insert into historial_movimientos (tipo_consecutivo, documento_numero, tipo_movimiento, naturaleza,
      fecha_registro, producto_id, cantidad, valor_unitario, valor_total, concepto, usuario_id, stock_resultante)
    values (v_consecutivo, v_consecutivo, '1007', 'ENTRADA', date '2026-03-01',
      v_producto.id_producto, p_saldo_inicial, p_valor_inicial, round(p_saldo_inicial * p_valor_inicial, 2),
      'Saldo inicial · carga masiva de catálogo', auth.uid(), p_saldo_inicial);
  end if;

  return json_build_object('id_producto', v_producto.id_producto, 'codigo_barra', v_producto.codigo_barra);
end $$;

create or replace function rpc_registrar_entrada_lote(
  p_fecha           date,
  p_tipo_movimiento text,
  p_proveedor_id    uuid,
  p_items           jsonb,
  p_nro_factura     text default null,
  p_nro_orden       text default null,
  p_concepto        text default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item        jsonb;
  v_prod        productos%rowtype;
  v_doc         text;
  v_linea       int := 0;
  v_fecha_ts    timestamptz;
  v_cant        numeric;
  v_valor       numeric;
  v_nuevo_stock numeric;
  v_nuevo_cpp   numeric;
  v_lineas      json[] := array[]::json[];
begin
  if not fn_puede_escribir() then
    raise exception 'Permiso denegado: se requiere rol Operativo o Administrador';
  end if;
  if p_tipo_movimiento not in ('1000','1002','1007','1210') then
    raise exception 'Tipo de movimiento de entrada no autorizado';
  end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'La entrada no tiene artículos';
  end if;

  if p_fecha < date '2026-03-01' then
    raise exception 'La fecha no puede ser anterior al 01/03/2026 (inicio de operación del sistema)';
  end if;
  if p_fecha > current_date then
    raise exception 'La fecha no puede ser posterior a hoy';
  end if;
  perform fn_verificar_periodo_abierto(p_fecha);

  v_fecha_ts := make_timestamptz(
    extract(year from p_fecha)::int, extract(month from p_fecha)::int, extract(day from p_fecha)::int,
    0, 0, 0, 'UTC'
  );

  v_doc := fn_siguiente_consecutivo('ENT');

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_linea := v_linea + 1;
    v_cant  := (v_item->>'cantidad')::numeric;
    v_valor := (v_item->>'valor_unitario')::numeric;
    if v_cant is null or v_cant <= 0 then
      raise exception 'Línea %: la cantidad debe ser mayor a 0', v_linea;
    end if;
    if v_valor is null or v_valor < 0 then
      raise exception 'Línea %: el valor unitario no puede ser negativo', v_linea;
    end if;

    select * into v_prod from productos
    where id_producto = (v_item->>'producto_id')::uuid for update;
    if not found then
      raise exception 'Línea %: producto no encontrado', v_linea;
    end if;

    v_nuevo_stock := v_prod.stock_real + v_cant;
    v_nuevo_cpp := case when v_nuevo_stock = 0 then v_valor
      else round(((v_prod.stock_real * v_prod.costo_promedio_ponderado) + (v_cant * v_valor)) / v_nuevo_stock, 4) end;

    update productos set
      stock_real = v_nuevo_stock,
      costo_promedio_ponderado = v_nuevo_cpp,
      ultimo_valor_unitario = v_valor
    where id_producto = v_prod.id_producto;

    insert into historial_movimientos (tipo_consecutivo, documento_numero, tipo_movimiento, naturaleza,
      fecha_registro, producto_id, cantidad, valor_unitario, valor_total,
      proveedor_id, nro_factura, nro_orden, concepto, usuario_id, stock_resultante)
    values (v_doc || '-' || lpad(v_linea::text, 2, '0'), v_doc, p_tipo_movimiento, 'ENTRADA', v_fecha_ts,
      v_prod.id_producto, v_cant, v_valor, round(v_cant * v_valor, 2),
      p_proveedor_id, p_nro_factura, p_nro_orden, p_concepto, auth.uid(), v_nuevo_stock);

    v_lineas := v_lineas || json_build_object('producto', v_prod.nombre, 'cantidad', v_cant, 'nuevo_stock', v_nuevo_stock);
  end loop;

  return json_build_object('documento', v_doc, 'lineas', v_linea, 'detalle', array_to_json(v_lineas));
end $$;

create or replace function rpc_registrar_salida_lote(
  p_fecha           date,
  p_tipo_movimiento text,
  p_items           jsonb,
  p_proveedor_id    uuid default null,
  p_concepto        text default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item        jsonb;
  v_prod        productos%rowtype;
  v_doc         text;
  v_linea       int := 0;
  v_fecha_ts    timestamptz;
  v_cant        numeric;
  v_nuevo_stock numeric;
  v_lineas      json[] := array[]::json[];
begin
  if not fn_puede_escribir() then
    raise exception 'Permiso denegado: se requiere rol Operativo o Administrador';
  end if;
  if p_tipo_movimiento not in ('2000','2003') then
    raise exception 'Tipo de movimiento de salida no autorizado';
  end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'La salida no tiene artículos';
  end if;

  if p_fecha < date '2026-03-01' then
    raise exception 'La fecha no puede ser anterior al 01/03/2026 (inicio de operación del sistema)';
  end if;
  if p_fecha > current_date then
    raise exception 'La fecha no puede ser posterior a hoy';
  end if;
  perform fn_verificar_periodo_abierto(p_fecha);

  v_fecha_ts := make_timestamptz(
    extract(year from p_fecha)::int, extract(month from p_fecha)::int, extract(day from p_fecha)::int,
    0, 0, 0, 'UTC'
  );

  v_doc := fn_siguiente_consecutivo('SAL');

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_linea := v_linea + 1;
    v_cant := (v_item->>'cantidad')::numeric;
    if v_cant is null or v_cant <= 0 then
      raise exception 'Línea %: la cantidad debe ser mayor a 0', v_linea;
    end if;

    select * into v_prod from productos
    where id_producto = (v_item->>'producto_id')::uuid for update;
    if not found then
      raise exception 'Línea %: producto no encontrado', v_linea;
    end if;
    if v_cant > v_prod.stock_real then
      raise exception 'Línea % (%): STOCK_INSUFICIENTE — disponible %, solicitado %', v_linea, v_prod.nombre, v_prod.stock_real, v_cant;
    end if;

    v_nuevo_stock := v_prod.stock_real - v_cant;
    update productos set stock_real = v_nuevo_stock where id_producto = v_prod.id_producto;

    insert into historial_movimientos (tipo_consecutivo, documento_numero, tipo_movimiento, naturaleza,
      fecha_registro, producto_id, cantidad, valor_unitario, valor_total,
      proveedor_id, concepto, usuario_id, stock_resultante)
    values (v_doc || '-' || lpad(v_linea::text, 2, '0'), v_doc, p_tipo_movimiento, 'SALIDA', v_fecha_ts,
      v_prod.id_producto, v_cant, v_prod.costo_promedio_ponderado, round(v_cant * v_prod.costo_promedio_ponderado, 2),
      p_proveedor_id, p_concepto, auth.uid(), v_nuevo_stock);

    v_lineas := v_lineas || json_build_object('producto', v_prod.nombre, 'cantidad', v_cant, 'nuevo_stock', v_nuevo_stock);
  end loop;

  return json_build_object('documento', v_doc, 'lineas', v_linea, 'detalle', array_to_json(v_lineas));
end $$;

-- rpc_registrar_venta (módulo POS, sin ruta activa en la interfaz hoy, pero
-- se deja consistente): además de actualizar el permiso, se corrige un bug
-- ya presente — el insert a historial_movimientos no incluía
-- documento_numero, columna NOT NULL desde la migración 004; si alguna vez
-- se invocaba, fallaba. Se captura el consecutivo en una variable para
-- poder usarlo también como documento_numero.
create or replace function rpc_registrar_venta(
  p_items       jsonb,
  p_cliente_id  uuid default null,
  p_metodo_pago text default 'EFECTIVO'
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item       jsonb;
  v_prod       productos%rowtype;
  v_ticket     text;
  v_venta_id   uuid;
  v_subtotal   numeric := 0;
  v_cant       numeric;
  v_precio     numeric;
  v_consec_sal text;
begin
  if not fn_puede_escribir() then
    raise exception 'Permiso denegado: se requiere rol Operativo o Administrador';
  end if;
  if jsonb_array_length(p_items) = 0 then raise exception 'La venta no tiene ítems'; end if;

  v_ticket := fn_siguiente_consecutivo('TCK');
  insert into ventas (nro_ticket, cliente_id, subtotal, total, metodo_pago, usuario_id)
  values (v_ticket, p_cliente_id, 0, 0, p_metodo_pago, auth.uid())
  returning id_venta into v_venta_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_cant := (v_item->>'cantidad')::numeric;
    if v_cant <= 0 then raise exception 'Cantidad inválida en ítem'; end if;

    select * into v_prod from productos
    where id_producto = (v_item->>'producto_id')::uuid for update;
    if not found then raise exception 'Producto no encontrado en la venta'; end if;
    if v_cant > v_prod.stock_real then
      raise exception 'STOCK_INSUFICIENTE: % disponible %, solicitado %',
        v_prod.nombre, v_prod.stock_real, v_cant;
    end if;

    v_precio := case when v_prod.precio_venta > 0 then v_prod.precio_venta
                     else v_prod.costo_promedio_ponderado end;

    update productos set stock_real = stock_real - v_cant
    where id_producto = v_prod.id_producto;

    insert into venta_items (venta_id, producto_id, descripcion, talla, color,
      cantidad, valor_unitario, valor_total)
    values (v_venta_id, v_prod.id_producto, v_prod.nombre, v_prod.talla, v_prod.color,
      v_cant, v_precio, round(v_cant * v_precio, 2));

    v_consec_sal := fn_siguiente_consecutivo('SAL');
    insert into historial_movimientos (tipo_consecutivo, documento_numero, tipo_movimiento, naturaleza,
      fecha_registro, producto_id, cantidad, valor_unitario, valor_total,
      cliente_id, concepto, usuario_id, stock_resultante)
    values (v_consec_sal, v_consec_sal, '2000', 'SALIDA', now(), v_prod.id_producto,
      v_cant, v_prod.costo_promedio_ponderado,
      round(v_cant * v_prod.costo_promedio_ponderado, 2),
      p_cliente_id, 'VENTA POS ' || v_ticket, auth.uid(), v_prod.stock_real - v_cant);

    v_subtotal := v_subtotal + round(v_cant * v_precio, 2);
  end loop;

  update ventas set subtotal = v_subtotal, total = v_subtotal where id_venta = v_venta_id;
  if p_cliente_id is not null then
    update clientes set ultima_compra = now() where id_cliente = p_cliente_id;
  end if;

  return json_build_object('id_venta', v_venta_id, 'nro_ticket', v_ticket, 'total', v_subtotal);
end $$;

-- ----------------------------------------------------------------------------
-- 6. RPCs de control administrativo · exclusivas de Administrador
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
  if not fn_es_administrador() then
    raise exception 'Permiso denegado: se requiere rol Administrador';
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
  if not fn_es_administrador() then
    raise exception 'Permiso denegado: se requiere rol Administrador';
  end if;

  delete from periodos_bloqueados where anio_mes = v_mes;

  return json_build_object('anio_mes', v_mes, 'bloqueado', false);
end $$;

-- ----------------------------------------------------------------------------
-- 7. Limpieza · las versiones antiguas de un solo renglón (rpc_registrar_
--    entrada / rpc_registrar_salida) quedaron reemplazadas por las
--    versiones "_lote" desde hace varias migraciones y ya nadie las llama.
--    Además, tras el fix de zona horaria (migración 006) quedaron rotas:
--    seguían pasando un timestamptz a fn_verificar_periodo_abierto, que
--    ahora espera date. Se eliminan en vez de dejarlas como código muerto
--    e inconsistente.
-- ----------------------------------------------------------------------------
drop function if exists rpc_registrar_entrada(uuid, text, numeric, numeric, uuid, text, text, text, date);
drop function if exists rpc_registrar_salida(uuid, text, numeric, uuid, text, text, text, uuid);

-- ============================================================================
-- Fin de la migración 007.
-- ============================================================================


-- ############################################################################
--  migration_008_desactivar_articulos.sql
-- ############################################################################
-- ============================================================================
--  DIEGO TORRES · Migración 008 — Activar/Desactivar artículos con historial
--  Ejecutar en el SQL Editor de Supabase después de la migración 007.
--
--  Hasta ahora "productos.activo" solo servía para un caso: eliminar un
--  artículo SIN movimientos (el trigger bloqueaba por completo la baja de
--  cualquier artículo que ya tuviera historial en el kardex).
--
--  Ahora se agregan dos comportamientos distintos, según tenga o no
--  movimientos:
--   - Un artículo SIN movimientos se puede "Eliminar" (igual que antes).
--   - Un artículo CON movimientos ya NO se bloquea: se puede "Desactivar"
--     (deja de ofrecerse para nuevas entradas/salidas) y "Activar" de
--     nuevo cuando se necesite. Su historial (kardex, informe de cierre)
--     sigue mostrándolo con normalidad — nunca se borra ni se oculta un
--     movimiento ya registrado, solo se marca el artículo como inactivo
--     para uso operativo futuro.
--
--  Para saber, sin una consulta costosa por fila, si un artículo tiene
--  movimientos, se agrega una columna mantenida por trigger:
--  productos.tiene_movimientos.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Columna productos.tiene_movimientos, mantenida automáticamente
-- ----------------------------------------------------------------------------
alter table productos add column if not exists tiene_movimientos boolean not null default false;

update productos set tiene_movimientos = true
where id_producto in (select distinct producto_id from historial_movimientos);

create or replace function fn_marcar_producto_con_movimientos()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update productos set tiene_movimientos = true
  where id_producto = new.producto_id and not tiene_movimientos;
  return new;
end $$;

drop trigger if exists trg_marcar_producto_con_movimientos on historial_movimientos;
create trigger trg_marcar_producto_con_movimientos
after insert on historial_movimientos
for each row execute function fn_marcar_producto_con_movimientos();

-- ----------------------------------------------------------------------------
-- 2. Trigger de cambio de estado · ya no bloquea desactivar artículos con
--    movimientos, pero sigue exigiendo rol Administrador para cualquier
--    cambio de activo/inactivo (en ambas direcciones).
-- ----------------------------------------------------------------------------
create or replace function fn_bloquear_eliminacion_con_movimientos()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.activo <> old.activo then
    if not fn_es_administrador() then
      raise exception 'Permiso denegado: solo un Administrador puede activar o desactivar artículos';
    end if;
  end if;
  return new;
end $$;

-- ----------------------------------------------------------------------------
-- 3. rpc_informe_cierre · ya no excluye artículos inactivos que SÍ tienen
--    movimientos (antes desaparecían por completo de los informes en
--    cuanto se marcaban inactivos). Los artículos verdaderamente eliminados
--    (inactivos y sin ningún movimiento) se siguen excluyendo, porque no
--    aportan nada a un informe de kardex/inventario.
-- ----------------------------------------------------------------------------
create or replace function rpc_informe_cierre(
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
  v_grid          json;
  v_ent           numeric := 0;
  v_sal           numeric := 0;
  v_stock_final   numeric := 0;
  v_stock_inicial numeric := 0;
  v_valor_inicial numeric := 0;
  v_valor_final   numeric := 0;
  v_prom_ent      numeric := 0;
  v_prom_sal      numeric := 0;
  v_top_producto  text;
  v_mayor_stock   text;
  v_rotacion      numeric := 0;
  v_cobertura     numeric := 0;
  v_dias          integer;
  v_capacidad     numeric := 10000;   -- capacidad teórica del almacén (unidades)
  v_hasta_ts      timestamptz;
begin
  v_hasta_ts := (p_hasta + 1)::timestamptz;
  v_dias := greatest((p_hasta - p_desde) + 1, 1);

  select coalesce(sum(cantidad) filter (where naturaleza='ENTRADA'),0),
         coalesce(sum(cantidad) filter (where naturaleza='SALIDA'),0)
  into v_ent, v_sal
  from historial_movimientos
  where fecha_registro >= p_desde::timestamptz and fecha_registro < v_hasta_ts;

  select coalesce(sum(stock_real),0),
         coalesce(sum(stock_real * costo_promedio_ponderado),0)
  into v_stock_final, v_valor_final
  from productos where activo or tiene_movimientos;

  -- Valor retrospectivo exacto al inicio del período (stock actual revertido)
  with delta as (
    select producto_id,
      coalesce(sum(case when naturaleza='ENTRADA' then cantidad else -cantidad end),0) as neto,
      coalesce(sum(case when naturaleza='ENTRADA' then valor_total else -valor_total end),0) as neto_valor
    from historial_movimientos
    where fecha_registro >= p_desde::timestamptz and fecha_registro < v_hasta_ts
    group by producto_id
  )
  select coalesce(sum(p.stock_real - coalesce(d.neto,0)),0),
         coalesce(sum((p.stock_real * p.costo_promedio_ponderado) - coalesce(d.neto_valor,0)),0)
  into v_stock_inicial, v_valor_inicial
  from productos p left join delta d on d.producto_id = p.id_producto
  where p.activo or p.tiene_movimientos;

  v_prom_ent := round(v_ent / v_dias, 2);
  v_prom_sal := round(v_sal / v_dias, 2);
  v_rotacion := case when ((v_stock_inicial + v_stock_final)/2) > 0
    then round(v_sal / ((v_stock_inicial + v_stock_final)/2), 2) else 0 end;
  v_cobertura := case when v_prom_sal > 0 then round(v_stock_final / v_prom_sal, 1) else 0 end;

  select p.nombre || ' (' || p.codigo_barra || ')' into v_top_producto
  from historial_movimientos m join productos p on p.id_producto = m.producto_id
  where m.naturaleza='SALIDA'
    and m.fecha_registro >= p_desde::timestamptz and m.fecha_registro < v_hasta_ts
  group by p.id_producto, p.nombre, p.codigo_barra
  order by sum(m.cantidad) desc limit 1;

  select nombre || ' (' || codigo_barra || ')' into v_mayor_stock
  from productos where (activo or tiene_movimientos) order by stock_real desc limit 1;

  select coalesce(json_agg(t order by t.codigo), '[]'::json) into v_grid
  from (
    select p.codigo_barra as codigo, p.nombre as descripcion,
      p.stock_real
        - coalesce(sum(case when m.naturaleza='ENTRADA' then m.cantidad else -m.cantidad end)
            filter (where m.fecha_registro >= p_desde::timestamptz and m.fecha_registro < v_hasta_ts), 0)
        as stock_inicial,
      coalesce(sum(m.cantidad) filter (where m.naturaleza='ENTRADA'
        and m.fecha_registro >= p_desde::timestamptz and m.fecha_registro < v_hasta_ts),0) as entradas,
      coalesce(sum(m.cantidad) filter (where m.naturaleza='SALIDA'
        and m.fecha_registro >= p_desde::timestamptz and m.fecha_registro < v_hasta_ts),0) as salidas,
      p.stock_real as stock_final,
      round(p.stock_real * p.costo_promedio_ponderado, 2) as valor_total
    from productos p
    left join historial_movimientos m on m.producto_id = p.id_producto
    where p.activo or p.tiene_movimientos
    group by p.id_producto
  ) t;

  return json_build_object(
    'stock_inicial', v_stock_inicial, 'entradas', v_ent, 'salidas', v_sal,
    'stock_final', v_stock_final, 'rotacion', v_rotacion, 'cobertura_dias', v_cobertura,
    'promedio_entradas', v_prom_ent, 'promedio_salidas', v_prom_sal,
    'producto_top', coalesce(v_top_producto, '—'),
    'producto_mayor_stock', coalesce(v_mayor_stock, '—'),
    'valor_inicial', round(v_valor_inicial,2), 'valor_final', round(v_valor_final,2),
    'ocupacion_pct', round(least(v_stock_final / v_capacidad * 100, 100), 1),
    'grid', v_grid
  );
end $$;

-- ============================================================================
-- Fin de la migración 008.
-- ============================================================================


-- ############################################################################
--  migration_009_purgar_catalogo.sql
-- ############################################################################
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


-- ############################################################################
--  migration_010_fix_purgar_catalogo.sql
-- ############################################################################
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


-- ############################################################################
--  migration_011_auditoria_seguridad.sql
-- ############################################################################
-- ============================================================================
--  DIEGO TORRES · Migración 011 — Auditoría de seguridad y consistencia
--  Ejecutar en el SQL Editor de Supabase después de la migración 010.
--
--  Corrige hallazgos de una auditoría integral del sistema:
--
--  1. [CRÍTICO] Las políticas RLS de productos/historial_movimientos/ventas/
--     venta_items solo verificaban el ROL, pero Supabase otorga por defecto
--     privilegios de INSERT/UPDATE/DELETE de tabla completa a "authenticated"
--     — es decir, un usuario Operativo podía escribir esas tablas
--     DIRECTAMENTE desde el navegador (supabase.from('productos').update(...))
--     saltándose por completo la lógica de los RPC: sin recalcular el CPP,
--     sin verificar mes cerrado, sin dejar rastro en el kardex, e incluso
--     podía fabricar stock de la nada con un INSERT directo. Esto contradice
--     el requisito original de RBAC ("la base de datos debe rechazar
--     escrituras maliciosas, no solo la interfaz").
--     Arreglo: se revocan los privilegios amplios y se conceden de vuelta
--     solo en las columnas que el frontend legítimamente escribe de forma
--     directa (nunca las columnas de stock/costo, que solo tocan los RPC).
--     Los RPC siguen funcionando exactamente igual: al ser "security
--     definer" corren con los privilegios de su dueño (el rol que los creó,
--     normalmente el propietario de las tablas), no con los del usuario que
--     los invoca, así que estas revocaciones no los afectan en absoluto.
--
--  2. [CRÍTICO] fn_siguiente_consecutivo no verificaba ningún rol — hasta un
--     usuario Consulta podía invocarla directo (supabase.rpc(...)) y quemar
--     números de documento (ENT000000042...) sin que exista jamás el
--     movimiento real, rompiendo la garantía de secuencia consecutiva.
--
--  3. [MEDIO] rpc_registrar_venta (módulo POS, sin ruta activa hoy en la
--     interfaz, pero desplegado e invocable) nunca verificaba mes cerrado.
--
--  4. [MENOR] Limpieza: se elimina fn_verificar_periodo_abierto(timestamptz),
--     una sobrecarga huérfana desde la migración 007 (nadie la llama, pero
--     su sola existencia es el mismo patrón que causó el bug de zona
--     horaria original si algún código nuevo la reintrodujera sin querer).
--
--  5. [MENOR] rpc_informe_cierre no validaba que "desde" <= "hasta"; con
--     fechas invertidas devolvía silenciosamente un informe en ceros en vez
--     de avisar del error.
--
--  6. [MENOR] rpc_importar_articulo_inicial no manejaba colisiones de
--     artículos duplicados con un mensaje claro (a diferencia de
--     rpc_crear_articulo, que sí lo hace) — una carga masiva repetida por
--     error fallaba con un error crudo de Postgres.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Privilegios de columna: solo los RPC pueden tocar stock/costo/consecutivos
-- ----------------------------------------------------------------------------

-- productos: el frontend solo edita nombre/genero/color/talla directamente,
-- y solo cambia "activo" (ya protegido además por el trigger que exige
-- Administrador). Nunca inserta ni borra filas de forma directa — eso vive
-- exclusivamente en rpc_crear_articulo / rpc_importar_articulo_inicial.
revoke insert, update, delete on productos from authenticated;
grant update (nombre, genero, color, talla, activo) on productos to authenticated;

-- El kardex y las ventas son de solo lectura para el cliente: toda escritura
-- pasa por rpc_registrar_entrada_lote / rpc_registrar_salida_lote /
-- rpc_registrar_venta / rpc_importar_articulo_inicial.
revoke insert, update, delete on historial_movimientos from authenticated;
revoke insert, update, delete on ventas from authenticated;
revoke insert, update, delete on venta_items from authenticated;

-- familias: el frontend (Catálogos, exclusivo de Administrador) solo edita
-- código y nombre; el contador interno consecutivo_familia solo lo debe
-- tocar rpc_crear_articulo (bajo "for update", con bloqueo de fila).
revoke insert, update, delete on familias from authenticated;
grant insert (codigo, nombre) on familias to authenticated;
grant update (codigo, nombre) on familias to authenticated;
grant delete on familias to authenticated;

-- ----------------------------------------------------------------------------
-- 2. fn_siguiente_consecutivo · ahora exige poder de escritura
-- ----------------------------------------------------------------------------
create or replace function fn_siguiente_consecutivo(p_tipo text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare v_num bigint;
begin
  if not fn_puede_escribir() then
    raise exception 'Permiso denegado: se requiere rol Operativo o Administrador';
  end if;

  update consecutivos set ultimo = ultimo + 1
  where tipo = p_tipo
  returning ultimo into v_num;

  return p_tipo || lpad(v_num::text, 9, '0');
end $$;

-- ----------------------------------------------------------------------------
-- 3. rpc_registrar_venta · agrega verificación de mes cerrado (usa la fecha
--    de hoy, ya que este RPC siempre registra con fecha_registro = now())
-- ----------------------------------------------------------------------------
create or replace function rpc_registrar_venta(
  p_items       jsonb,
  p_cliente_id  uuid default null,
  p_metodo_pago text default 'EFECTIVO'
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item       jsonb;
  v_prod       productos%rowtype;
  v_ticket     text;
  v_venta_id   uuid;
  v_subtotal   numeric := 0;
  v_cant       numeric;
  v_precio     numeric;
  v_consec_sal text;
begin
  if not fn_puede_escribir() then
    raise exception 'Permiso denegado: se requiere rol Operativo o Administrador';
  end if;
  if jsonb_array_length(p_items) = 0 then raise exception 'La venta no tiene ítems'; end if;
  perform fn_verificar_periodo_abierto(current_date);

  v_ticket := fn_siguiente_consecutivo('TCK');
  insert into ventas (nro_ticket, cliente_id, subtotal, total, metodo_pago, usuario_id)
  values (v_ticket, p_cliente_id, 0, 0, p_metodo_pago, auth.uid())
  returning id_venta into v_venta_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_cant := (v_item->>'cantidad')::numeric;
    if v_cant <= 0 then raise exception 'Cantidad inválida en ítem'; end if;

    select * into v_prod from productos
    where id_producto = (v_item->>'producto_id')::uuid for update;
    if not found then raise exception 'Producto no encontrado en la venta'; end if;
    if v_cant > v_prod.stock_real then
      raise exception 'STOCK_INSUFICIENTE: % disponible %, solicitado %',
        v_prod.nombre, v_prod.stock_real, v_cant;
    end if;

    v_precio := case when v_prod.precio_venta > 0 then v_prod.precio_venta
                     else v_prod.costo_promedio_ponderado end;

    update productos set stock_real = stock_real - v_cant
    where id_producto = v_prod.id_producto;

    insert into venta_items (venta_id, producto_id, descripcion, talla, color,
      cantidad, valor_unitario, valor_total)
    values (v_venta_id, v_prod.id_producto, v_prod.nombre, v_prod.talla, v_prod.color,
      v_cant, v_precio, round(v_cant * v_precio, 2));

    v_consec_sal := fn_siguiente_consecutivo('SAL');
    insert into historial_movimientos (tipo_consecutivo, documento_numero, tipo_movimiento, naturaleza,
      fecha_registro, producto_id, cantidad, valor_unitario, valor_total,
      cliente_id, concepto, usuario_id, stock_resultante)
    values (v_consec_sal, v_consec_sal, '2000', 'SALIDA', now(), v_prod.id_producto,
      v_cant, v_prod.costo_promedio_ponderado,
      round(v_cant * v_prod.costo_promedio_ponderado, 2),
      p_cliente_id, 'VENTA POS ' || v_ticket, auth.uid(), v_prod.stock_real - v_cant);

    v_subtotal := v_subtotal + round(v_cant * v_precio, 2);
  end loop;

  update ventas set subtotal = v_subtotal, total = v_subtotal where id_venta = v_venta_id;
  if p_cliente_id is not null then
    update clientes set ultima_compra = now() where id_cliente = p_cliente_id;
  end if;

  return json_build_object('id_venta', v_venta_id, 'nro_ticket', v_ticket, 'total', v_subtotal);
end $$;

-- ----------------------------------------------------------------------------
-- 4. Limpieza de función huérfana
-- ----------------------------------------------------------------------------
drop function if exists fn_verificar_periodo_abierto(timestamptz);

-- ----------------------------------------------------------------------------
-- 5. rpc_informe_cierre · valida que "desde" no sea posterior a "hasta"
-- ----------------------------------------------------------------------------
create or replace function rpc_informe_cierre(
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
  v_grid          json;
  v_ent           numeric := 0;
  v_sal           numeric := 0;
  v_stock_final   numeric := 0;
  v_stock_inicial numeric := 0;
  v_valor_inicial numeric := 0;
  v_valor_final   numeric := 0;
  v_prom_ent      numeric := 0;
  v_prom_sal      numeric := 0;
  v_top_producto  text;
  v_mayor_stock   text;
  v_rotacion      numeric := 0;
  v_cobertura     numeric := 0;
  v_dias          integer;
  v_capacidad     numeric := 10000;   -- capacidad teórica del almacén (unidades)
  v_hasta_ts      timestamptz;
begin
  if p_desde > p_hasta then
    raise exception 'La fecha "Desde" no puede ser posterior a la fecha "Hasta"';
  end if;

  v_hasta_ts := (p_hasta + 1)::timestamptz;
  v_dias := greatest((p_hasta - p_desde) + 1, 1);

  select coalesce(sum(cantidad) filter (where naturaleza='ENTRADA'),0),
         coalesce(sum(cantidad) filter (where naturaleza='SALIDA'),0)
  into v_ent, v_sal
  from historial_movimientos
  where fecha_registro >= p_desde::timestamptz and fecha_registro < v_hasta_ts;

  select coalesce(sum(stock_real),0),
         coalesce(sum(stock_real * costo_promedio_ponderado),0)
  into v_stock_final, v_valor_final
  from productos where activo or tiene_movimientos;

  -- Valor retrospectivo exacto al inicio del período (stock actual revertido)
  with delta as (
    select producto_id,
      coalesce(sum(case when naturaleza='ENTRADA' then cantidad else -cantidad end),0) as neto,
      coalesce(sum(case when naturaleza='ENTRADA' then valor_total else -valor_total end),0) as neto_valor
    from historial_movimientos
    where fecha_registro >= p_desde::timestamptz and fecha_registro < v_hasta_ts
    group by producto_id
  )
  select coalesce(sum(p.stock_real - coalesce(d.neto,0)),0),
         coalesce(sum((p.stock_real * p.costo_promedio_ponderado) - coalesce(d.neto_valor,0)),0)
  into v_stock_inicial, v_valor_inicial
  from productos p left join delta d on d.producto_id = p.id_producto
  where p.activo or p.tiene_movimientos;

  v_prom_ent := round(v_ent / v_dias, 2);
  v_prom_sal := round(v_sal / v_dias, 2);
  v_rotacion := case when ((v_stock_inicial + v_stock_final)/2) > 0
    then round(v_sal / ((v_stock_inicial + v_stock_final)/2), 2) else 0 end;
  v_cobertura := case when v_prom_sal > 0 then round(v_stock_final / v_prom_sal, 1) else 0 end;

  select p.nombre || ' (' || p.codigo_barra || ')' into v_top_producto
  from historial_movimientos m join productos p on p.id_producto = m.producto_id
  where m.naturaleza='SALIDA'
    and m.fecha_registro >= p_desde::timestamptz and m.fecha_registro < v_hasta_ts
  group by p.id_producto, p.nombre, p.codigo_barra
  order by sum(m.cantidad) desc limit 1;

  select nombre || ' (' || codigo_barra || ')' into v_mayor_stock
  from productos where (activo or tiene_movimientos) order by stock_real desc limit 1;

  select coalesce(json_agg(t order by t.codigo), '[]'::json) into v_grid
  from (
    select p.codigo_barra as codigo, p.nombre as descripcion,
      p.stock_real
        - coalesce(sum(case when m.naturaleza='ENTRADA' then m.cantidad else -m.cantidad end)
            filter (where m.fecha_registro >= p_desde::timestamptz and m.fecha_registro < v_hasta_ts), 0)
        as stock_inicial,
      coalesce(sum(m.cantidad) filter (where m.naturaleza='ENTRADA'
        and m.fecha_registro >= p_desde::timestamptz and m.fecha_registro < v_hasta_ts),0) as entradas,
      coalesce(sum(m.cantidad) filter (where m.naturaleza='SALIDA'
        and m.fecha_registro >= p_desde::timestamptz and m.fecha_registro < v_hasta_ts),0) as salidas,
      p.stock_real as stock_final,
      round(p.stock_real * p.costo_promedio_ponderado, 2) as valor_total
    from productos p
    left join historial_movimientos m on m.producto_id = p.id_producto
    where p.activo or p.tiene_movimientos
    group by p.id_producto
  ) t;

  return json_build_object(
    'stock_inicial', v_stock_inicial, 'entradas', v_ent, 'salidas', v_sal,
    'stock_final', v_stock_final, 'rotacion', v_rotacion, 'cobertura_dias', v_cobertura,
    'promedio_entradas', v_prom_ent, 'promedio_salidas', v_prom_sal,
    'producto_top', coalesce(v_top_producto, '—'),
    'producto_mayor_stock', coalesce(v_mayor_stock, '—'),
    'valor_inicial', round(v_valor_inicial,2), 'valor_final', round(v_valor_final,2),
    'ocupacion_pct', round(least(v_stock_final / v_capacidad * 100, 100), 1),
    'grid', v_grid
  );
end $$;

-- ----------------------------------------------------------------------------
-- 6. rpc_importar_articulo_inicial · maneja duplicados con mensaje claro,
--    igual que rpc_crear_articulo
-- ----------------------------------------------------------------------------
create or replace function rpc_importar_articulo_inicial(
  p_codigo_barra  text,
  p_nombre        text,
  p_id_familia    uuid,
  p_genero        text default null,
  p_color         text default null,
  p_talla         text default null,
  p_saldo_inicial numeric default 0,
  p_valor_inicial numeric default 0
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
  v_consecutivo text;
begin
  if not fn_puede_escribir() then
    raise exception 'Permiso denegado: se requiere rol Operativo o Administrador';
  end if;
  if v_codigo = '' then raise exception 'El código del producto es obligatorio'; end if;
  if v_nombre = '' then raise exception 'El nombre es obligatorio'; end if;
  if p_saldo_inicial < 0 then raise exception 'El saldo inicial no puede ser negativo'; end if;
  if p_valor_inicial < 0 then raise exception 'El valor inicial no puede ser negativo'; end if;

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
    values (v_consecutivo, v_consecutivo, '1007', 'ENTRADA', date '2026-03-01',
      v_producto.id_producto, p_saldo_inicial, p_valor_inicial, round(p_saldo_inicial * p_valor_inicial, 2),
      'Saldo inicial · carga masiva de catálogo', auth.uid(), p_saldo_inicial);
  end if;

  return json_build_object('id_producto', v_producto.id_producto, 'codigo_barra', v_producto.codigo_barra);
end $$;

-- ============================================================================
-- Fin de la migración 011.
-- ============================================================================


-- ############################################################################
--  migration_012_kardex_general.sql
-- ############################################################################
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


-- ############################################################################
--  migration_013_busqueda_optimizada.sql
-- ############################################################################
 -- ============================================================================
--  DIEGO TORRES · Migración 013 — Motor de búsqueda unificado
--  Ejecutar en el SQL Editor de Supabase después de la migración 012.
--  Segura de volver a ejecutar (create extension/or replace/if not exists):
--  si ya la corrió antes, este archivo corrige un bug de la primera versión.
--
--  Problema que corrige (búsqueda):
--  El buscador de artículos (BuscadorProducto, usado en Entradas/Salidas/
--  Kardex) armaba el filtro `ilike` a mano en el cliente y lo mandaba tal
--  cual a PostgREST. Eso funcionaba para mayúsculas/minúsculas (ilike ya es
--  insensible a eso) pero NO para tildes: como el nombre del artículo se
--  guarda tal como lo escribió el usuario al crearlo (solo se le aplica
--  upper(trim(...)), nunca se le quitan acentos — ver rpc_crear_articulo),
--  buscar "pantalon" nunca encontraba "PANTALÓN" y viceversa. Además, la
--  lógica de "separar por palabras y exigir que cada una aparezca en algún
--  campo" vivía SOLO en el cliente (ui.tsx), duplicada de forma incompleta
--  (sin separar por palabras) en Articulos.tsx y Maestro.tsx.
--
--  Esta migración centraliza el matching en una sola función SQL
--  (fn_normalizar + rpc_buscar_productos) que ignora tildes (extensión
--  unaccent), mayúsculas/minúsculas y busca por palabras: cada palabra
--  escrita debe aparecer en ALGÚN campo (nombre, código, género, color o
--  talla), no necesariamente todas en el mismo campo.
--
--  Bug corregido en ESTA versión (causaba "No se pudo buscar productos" en
--  TODA búsqueda, ver captura de pantalla del error en Salidas):
--  Supabase instala las extensiones (unaccent, pg_trgm) en el esquema
--  "extensions", no en "public". La primera versión de fn_normalizar y
--  rpc_buscar_productos fijaban `set search_path = public` (o ninguno), y
--  ese `search_path` es el que usa la función CADA VEZ que se ejecuta vía
--  PostgREST — no el search_path de la sesión del SQL Editor donde se corrió
--  esta migración. Como resultado, unaccent() nunca se encontraba en tiempo
--  de ejecución y la función fallaba con error en cada llamada, sin importar
--  que la migración se hubiese ejecutado sin errores. Se corrige agregando
--  "extensions" al search_path de ambas funciones. También se retira el
--  índice de trigramas (pg_trgm) para reducir superficie de fallo: con el
--  tamaño de catálogo de este sistema, un filtro secuencial con `like` sobre
--  texto ya normalizado es suficientemente rápido sin índice especializado.
--
--  Segundo problema corregido en ESTA versión ("Sin coincidencias" al buscar
--  con una descripción larga, ej. "CAMISETA POLO M/C BLANCA HOMBRE"):
--  rpc_buscar_productos exigía que TODAS las palabras escritas aparecieran
--  en algún campo (AND estricto). Es preciso, pero es frágil apenas una sola
--  palabra no calza exactamente con lo guardado (abreviaturas como "M/C" en
--  vez de "MANGA CORTA", una palabra de más, un plural) — toda la búsqueda
--  se queda en cero resultados aunque el artículo exista y el resto de las
--  palabras sí coincidan. Ahora, si la búsqueda estricta no encuentra nada,
--  la función reintenta automáticamente permitiendo coincidencias parciales
--  (basta con que UNA palabra coincida) y ordena los resultados por cuántas
--  palabras sí coincidieron, mostrando primero los más relevantes. El
--  usuario nunca se queda con "Sin coincidencias" mientras al menos una
--  palabra de lo que escribió aparezca en algún artículo.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Extensión necesaria (contrib estándar, disponible en todo plan de
--    Supabase, no requiere privilegios especiales).
-- ----------------------------------------------------------------------------
create extension if not exists unaccent;

-- ----------------------------------------------------------------------------
-- 2. fn_normalizar · MAYÚSCULAS + sin tildes, envuelta como IMMUTABLE.
--    unaccent(text) de por sí es STABLE (depende del diccionario de sesión),
--    lo cual impide usarla en un índice funcional. Fijar el diccionario
--    explícitamente a 'unaccent' vía unaccent(regdictionary, text) permite
--    marcar el envoltorio como IMMUTABLE de forma segura.
--    search_path incluye "extensions" porque ahí es donde Supabase instala
--    unaccent por defecto (ver nota de bug arriba) — sin esto, la función
--    falla en tiempo de ejecución aunque la migración se haya "aplicado bien".
-- ----------------------------------------------------------------------------
create or replace function fn_normalizar(p_texto text)
returns text
language sql
immutable
parallel safe
set search_path = public, extensions
as $$
  select upper(unaccent('unaccent'::regdictionary, coalesce(p_texto, '')));
$$;

-- ----------------------------------------------------------------------------
-- 3. rpc_buscar_productos · reemplaza el filtro `.or()` armado a mano en
--    BuscadorProducto (src/components/ui.tsx). `stable` porque solo lee.
--    No exige rol: los 3 roles (consulta/operativo/administrador) pueden
--    buscar artículos, igual que antes.
-- ----------------------------------------------------------------------------
create or replace function rpc_buscar_productos(
  p_termino      text,
  p_solo_activos boolean default true,
  p_limite       int default 8
)
returns setof productos
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_termino    text := trim(coalesce(p_termino, ''));
  v_palabras   text[];
  v_encontrados int;
  v_limite     int := greatest(1, least(coalesce(p_limite, 8), 50));
begin
  if length(v_termino) < 2 then
    return;
  end if;

  -- Parte en palabras (máx. 6, igual que el límite que antes aplicaba el
  -- cliente, para no admitir consultas arbitrariamente largas/costosas).
  select array_agg(w) into v_palabras
  from (
    select unnest(regexp_split_to_array(fn_normalizar(v_termino), '\s+')) as w
    limit 6
  ) s
  where w <> '';

  if v_palabras is null or array_length(v_palabras, 1) = 0 then
    return;
  end if;

  -- Paso 1 (preciso): exige que TODAS las palabras aparezcan en algún campo.
  return query
  select p.*
  from productos p
  where (p_solo_activos = false or p.activo = true)
    and not exists (
      select 1 from unnest(v_palabras) as palabra
      where not (
        fn_normalizar(p.nombre) like '%' || palabra || '%'
        or fn_normalizar(p.codigo_barra) like '%' || palabra || '%'
        or fn_normalizar(coalesce(p.genero, '')) like '%' || palabra || '%'
        or fn_normalizar(coalesce(p.color, '')) like '%' || palabra || '%'
        or fn_normalizar(coalesce(p.talla, '')) like '%' || palabra || '%'
      )
    )
  order by
    (fn_normalizar(p.codigo_barra) = v_palabras[1]) desc,
    (fn_normalizar(p.nombre) like v_palabras[1] || '%') desc,
    p.nombre
  limit v_limite;

  get diagnostics v_encontrados = row_count;
  if v_encontrados > 0 then
    return;
  end if;

  -- Paso 2 (tolerante, solo si el paso 1 no encontró nada): basta con que
  -- UNA palabra coincida en algún campo. Ordena por cuántas palabras
  -- coincidieron (más relevante primero) para que, aun con una búsqueda
  -- imprecisa, el usuario vea los candidatos más cercanos en vez de una
  -- lista vacía.
  return query
  select p.*
  from productos p
  join lateral (
    select count(*) as coincidencias
    from unnest(v_palabras) as palabra
    where fn_normalizar(p.nombre) like '%' || palabra || '%'
       or fn_normalizar(p.codigo_barra) like '%' || palabra || '%'
       or fn_normalizar(coalesce(p.genero, '')) like '%' || palabra || '%'
       or fn_normalizar(coalesce(p.color, '')) like '%' || palabra || '%'
       or fn_normalizar(coalesce(p.talla, '')) like '%' || palabra || '%'
  ) m on true
  where (p_solo_activos = false or p.activo = true)
    and m.coincidencias > 0
  order by m.coincidencias desc, p.nombre
  limit v_limite;
end $$;

-- ============================================================================
-- Fin de la migración 013.
-- ============================================================================


-- ############################################################################
--  migration_014_fecha_creacion_movimiento.sql
-- ############################################################################
-- ============================================================================
--  DIEGO TORRES · Migración 014 — Fecha real de registro en el Kardex
--  Ejecutar en el SQL Editor de Supabase después de la migración 013.
--  Segura de volver a ejecutar (guardas "if not exists" / "if exists").
--
--  Problema que corrige:
--  En "Kardex → Todos los movimientos" la única fecha que se mostraba era
--  `fecha_registro`, que NO es un instante real: es el día de calendario
--  que el usuario elige a mano al digitar una entrada o salida (ver
--  rpc_registrar_entrada_lote / rpc_registrar_salida_lote, migración 006/007),
--  guardado como medianoche UTC explícita de ese día. Si el usuario digita
--  hoy un movimiento fechado el 01/03/2026 (inicio de operación), la fila
--  muestra "01/03/2026" aunque se haya registrado hoy — eso es correcto para
--  el kardex contable, pero no hay forma de saber CUÁNDO se digitó realmente
--  cada movimiento en el sistema (trazabilidad/auditoría).
--
--  Solución: se agrega `fecha_creacion`, un timestamp real (instante del
--  servidor al momento del INSERT, con default now()), independiente de
--  `fecha_registro`. Los movimientos ya existentes no tienen forma de saber
--  su instante real de creación (nunca se guardó), así que NO se rellenan
--  copiando `fecha_registro` — hacerlo reproduce dos problemas a la vez:
--   1) Semántico: `fecha_registro` es la fecha CONTABLE del movimiento (ej.
--      01/03/2026 para la carga inicial de inventario), casi siempre muy
--      anterior a cuándo se digitó de verdad ese movimiento en el sistema
--      (aquí, en producción, desde julio 2026 en adelante). Copiarla haría
--      ver "fecha de registro" 01/03/2026 para algo digitado en agosto.
--   2) Zona horaria: `fecha_registro` se guarda como medianoche UTC
--      EXPLÍCITA de un día de calendario (no es un instante real), pero
--      `fecha_creacion` se muestra en el frontend con fechaSegura(), que
--      lee en hora LOCAL. Medianoche UTC del 01/03/2026 cae en hora local
--      de Colombia/Perú (UTC-5) el 28/02/2026 a las 19:00 — el mismo bug de
--      un día atrás que ya se documentó y corrigió en la migración 006,
--      reintroducido aquí por copiar un valor que no es un instante real.
--  En vez de eso, se deja que el DEFAULT now() de la columna nueva asigne su
--  propio valor a las filas existentes (Postgres evalúa `now()` una sola vez
--  para todo el ALTER TABLE, así que todas las filas históricas quedan con
--  la fecha/hora en que se corrió esta migración — un valor sincero: "no se
--  sabe con exactitud cuándo se digitó cada una, se marca la fecha en que
--  se activó esta trazabilidad"). De aquí en adelante, cada INSERT nuevo
--  (que no menciona esta columna) recibe automáticamente el instante real
--  vía el DEFAULT — no hace falta tocar rpc_registrar_entrada_lote/
--  rpc_registrar_salida_lote/rpc_registrar_venta.
--
--  IMPORTANTE — no confundir en el frontend:
--   · fecha_registro → fecha de MOVIMIENTO (día de calendario elegido por el
--     usuario). Se sigue formateando con fechaMovimiento() (UTC explícito).
--   · fecha_creacion → fecha/hora REAL de registro en el sistema (instante).
--     Se formatea con fechaSegura() (hora local), tal como ya advertía el
--     comentario de esa función en src/utils/format.ts antes de que esta
--     columna existiera.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Columna nueva, protegida con "if not exists" para que el archivo se
--    pueda volver a correr sin error si ya se había ejecutado antes.
-- ----------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_name = 'historial_movimientos' and column_name = 'fecha_creacion'
  ) then
    -- No se hace ningún UPDATE de backfill después de este ALTER: el propio
    -- DEFAULT now() ya deja las filas existentes con la fecha/hora de esta
    -- migración (ver nota arriba de por qué NO se copia fecha_registro).
    alter table historial_movimientos
      add column fecha_creacion timestamptz not null default now();
  end if;
end $$;

create index if not exists idx_mov_fecha_creacion on historial_movimientos (fecha_creacion);

-- ----------------------------------------------------------------------------
-- 2. rpc_kardex_general · agrega fecha_creacion a la vista "Todos los
--    movimientos". El filtro de rango (p_desde/p_hasta) sigue operando
--    sobre fecha_registro (fecha de movimiento) — sin cambios ahí, para no
--    alterar qué filas trae cada búsqueda ya existente.
-- ----------------------------------------------------------------------------
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

  v_hasta_ts := (p_hasta + 1)::timestamptz;

  select coalesce(json_agg(t order by t.fecha_registro desc, t.tipo_consecutivo desc), '[]'::json) into v_rows
  from (
    select
      m.tipo_consecutivo, m.documento_numero, m.tipo_movimiento, m.naturaleza,
      m.fecha_registro, m.fecha_creacion, m.cantidad, m.valor_unitario, m.valor_total, m.stock_resultante,
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

-- ----------------------------------------------------------------------------
-- 3. rpc_kardex_producto · misma columna agregada en el kardex "Por
--    artículo", por consistencia (evita que una pantalla la tenga y la
--    otra no).
-- ----------------------------------------------------------------------------
create or replace function rpc_kardex_producto(
  p_producto_id uuid,
  p_modo        text default 'MES',
  p_anio        integer default null
)
returns json
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_desde timestamptz;
  v_hasta timestamptz;
  v_rows  json;
begin
  if p_modo = 'MES' then
    v_desde := date_trunc('month', now());
    v_hasta := now();
  elsif p_modo = 'ANIO' then
    v_desde := date_trunc('year', now());
    v_hasta := now();
  else
    if p_anio is null then raise exception 'Debe indicar el año histórico'; end if;
    v_desde := make_timestamptz(p_anio, 1, 1, 0, 0, 0);
    v_hasta := make_timestamptz(p_anio, 12, 31, 23, 59, 59);
  end if;

  select coalesce(json_agg(t order by t.fecha_registro desc), '[]'::json) into v_rows
  from (
    select m.tipo_consecutivo, m.tipo_movimiento, m.naturaleza, m.fecha_registro, m.fecha_creacion,
           m.cantidad, m.valor_unitario, m.valor_total, m.stock_resultante,
           m.nro_factura, m.concepto, ter.razon_social as proveedor
    from historial_movimientos m
    left join terceros ter on ter.id_proveedor = m.proveedor_id
    where m.producto_id = p_producto_id
      and m.fecha_registro is not null                       -- validación estricta de nulos
      and m.fecha_registro >= '1990-01-01'::timestamptz      -- descarta fechas basura (30/12/1899)
      and m.fecha_registro between v_desde and v_hasta
  ) t;

  return v_rows;
end $$;

-- ============================================================================
-- Fin de la migración 014.
-- ============================================================================


-- ############################################################################
--  migration_015_corrige_backfill_fecha_creacion.sql
-- ############################################################################
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


-- ############################################################################
--  migration_016_correccion_valor_producto.sql
-- ############################################################################
-- ============================================================================
--  DIEGO TORRES · Migración 016 — Corrección de valor de inventario (9000)
--  Ejecutar en el SQL Editor de Supabase después de la migración 015.
--  Segura de volver a ejecutar (create or replace / drop-and-recreate del
--  único CHECK que toca).
--
--  Necesidad que resuelve:
--  El costo de un artículo (productos.costo_promedio_ponderado) puede
--  quedar mal digitado (error de captura en una entrada pasada, saldo
--  inicial cargado con el valor equivocado, etc.). Hasta ahora la única
--  forma de tocar ese valor era registrar una entrada real
--  (rpc_registrar_entrada_lote), que SIEMPRE suma cantidad al stock — no
--  sirve para "solo corregir el valor" sin alterar las existencias
--  físicas, que es justo lo que se necesita: la bata sigue teniendo el
--  mismo stock, solo cambia el costo con el que está valorizada.
--
--  Se agrega el tipo de movimiento 9000 "Corrección de valor de
--  inventario", con su propio RPC (rpc_corregir_valor_producto):
--
--   - EXCLUSIVO de Administrador. A diferencia de entradas/salidas
--     normales (Operativo o Administrador), corregir el costo de un
--     artículo es una operación contable sensible que puede alterar la
--     valorización de todo el inventario — se exige fn_es_administrador(),
--     no solo fn_puede_escribir().
--   - NO toca productos.stock_real: el trigger de bloqueo de mes y demás
--     reglas de stock ni se rozan, porque este RPC nunca hace
--     `stock_real = stock_real ± algo`.
--   - Si deja rastro en el kardex (historial_movimientos), con
--     tipo_movimiento='9000' y naturaleza='ENTRADA' (así lo pidió el
--     negocio: "un movimiento en entrada"), para trazabilidad de quién
--     corrigió qué valor, cuándo y con qué concepto — pero con
--     CANTIDAD = 0 a propósito. Esto es la pieza clave para no romper
--     nada: rpc_detalle_producto y rpc_informe_cierre reconstruyen el
--     stock al INICIO de un período restándole a las existencias
--     actuales la cantidad de los movimientos ENTRADA/SALIDA de ese
--     período. Si esta corrección sumara cantidad como una entrada real,
--     esa reconstrucción retrospectiva del stock quedaría mal (como si
--     hubiese entrado mercancía que en realidad nunca entró). Con
--     cantidad=0 esa resta no se altera y el stock inicial reconstruido
--     sigue siendo exacto.
--   - Guarda en valor_unitario el costo NUEVO (para que se vea directo en
--     el kardex, no un delta) y en valor_total el IMPACTO total del
--     ajuste: (valor_nuevo − valor_anterior) × stock_actual. No es
--     cosmético: rpc_informe_cierre reconstruye el valor de inventario al
--     INICIO de un período restando al valor actual la suma de
--     valor_total de los movimientos ENTRADA (menos SALIDA) de ese
--     período. Con este valor_total, esa cuenta también da exacta:
--       valor_actual − impacto
--         = (stock × valor_nuevo) − (stock × (valor_nuevo − valor_anterior))
--         = stock × valor_anterior   ← valor real antes de la corrección.
--
--  Requiere relajar el CHECK de historial_movimientos.cantidad (antes
--  exigía "> 0" estrictamente) a ">= 0", únicamente para permitir este
--  caso. Ningún otro RPC existente pasa cantidad=0: rpc_registrar_
--  entrada_lote, rpc_registrar_salida_lote y rpc_registrar_venta siguen
--  validando "cantidad > 0" en su propio código antes de insertar, así
--  que relajar el CHECK de tabla no abre ninguna puerta nueva ahí.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. historial_movimientos.cantidad · CHECK relajado de "> 0" a ">= 0"
--    (búsqueda dinámica del nombre real del constraint — mismo patrón que
--    usa la migración 007 para el CHECK de usuarios.rol — más robusto que
--    adivinar el nombre autogenerado por Postgres)
-- ----------------------------------------------------------------------------
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'historial_movimientos'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%cantidad%'
  loop
    execute format('alter table historial_movimientos drop constraint %I', c.conname);
  end loop;
end $$;

alter table historial_movimientos add constraint historial_movimientos_cantidad_check
  check (cantidad >= 0);

-- ----------------------------------------------------------------------------
-- 2. RPC · rpc_corregir_valor_producto — exclusiva de Administrador
-- ----------------------------------------------------------------------------
create or replace function rpc_corregir_valor_producto(
  p_producto_id uuid,
  p_valor_nuevo numeric,
  p_fecha       date default null,
  p_concepto    text default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prod        productos%rowtype;
  v_consecutivo text;
  v_fecha       date := coalesce(p_fecha, current_date);
  v_fecha_ts    timestamptz;
  v_valor_antes numeric;
  v_impacto     numeric;
  v_concepto    text := coalesce(nullif(trim(p_concepto), ''), 'Corrección de valor de inventario');
begin
  if not fn_es_administrador() then
    raise exception 'Permiso denegado: la corrección de valor de inventario es exclusiva del rol Administrador';
  end if;
  if p_valor_nuevo is null or p_valor_nuevo < 0 then
    raise exception 'El valor nuevo no puede ser negativo';
  end if;

  if v_fecha < date '2026-03-01' then
    raise exception 'La fecha no puede ser anterior al 01/03/2026 (inicio de operación del sistema)';
  end if;
  if v_fecha > current_date then
    raise exception 'La fecha no puede ser posterior a hoy';
  end if;
  -- Mismo respeto al cierre de mes que cualquier otro movimiento: si el
  -- período de la fecha elegida está cerrado, no se puede corregir ahí.
  perform fn_verificar_periodo_abierto(v_fecha);

  select * into v_prod from productos where id_producto = p_producto_id for update;
  if not found then raise exception 'Producto no encontrado'; end if;
  if not v_prod.activo then
    raise exception 'No se puede corregir el valor de un artículo inactivo. Actívelo primero desde Artículos.';
  end if;

  v_valor_antes := v_prod.costo_promedio_ponderado;
  if p_valor_nuevo = v_valor_antes then
    raise exception 'El valor nuevo es igual al valor actual del producto (%), no hay nada que corregir', v_valor_antes;
  end if;

  v_impacto := round((p_valor_nuevo - v_valor_antes) * v_prod.stock_real, 2);

  v_fecha_ts := make_timestamptz(
    extract(year from v_fecha)::int, extract(month from v_fecha)::int, extract(day from v_fecha)::int,
    0, 0, 0, 'UTC'
  );

  update productos set costo_promedio_ponderado = p_valor_nuevo
  where id_producto = p_producto_id;

  -- Reutiliza la serie de consecutivos ENT: sigue siendo, de cara al
  -- usuario, "un movimiento en entrada" — un único documento de una línea,
  -- imprimible desde el mismo módulo de Imprimir (Entrada de Almacén).
  v_consecutivo := fn_siguiente_consecutivo('ENT');

  -- cantidad = 0 a propósito (ver nota de cabecera): es una corrección de
  -- costo, no una entrada de mercancía. stock_resultante = stock actual,
  -- porque el stock no cambia con este movimiento.
  insert into historial_movimientos (tipo_consecutivo, documento_numero, tipo_movimiento, naturaleza,
    fecha_registro, producto_id, cantidad, valor_unitario, valor_total, concepto, usuario_id, stock_resultante)
  values (v_consecutivo, v_consecutivo, '9000', 'ENTRADA', v_fecha_ts,
    p_producto_id, 0, p_valor_nuevo, v_impacto, v_concepto, auth.uid(), v_prod.stock_real);

  return json_build_object(
    'consecutivo', v_consecutivo,
    'producto', v_prod.nombre,
    'valor_anterior', v_valor_antes,
    'valor_nuevo', p_valor_nuevo,
    'stock_actual', v_prod.stock_real
  );
end $$;

-- ============================================================================
-- Fin de la migración 016.
-- ============================================================================


-- ############################################################################
--  Limpieza final · funciones antiguas de un solo renglón
-- ############################################################################
-- rpc_registrar_entrada / rpc_registrar_salida (todas sus versiones, incluida
-- la de schema.sql que ninguna migración eliminaba) y
-- fn_verificar_periodo_abierto(timestamptz). La app usa solo las versiones
-- "_lote"; estas permitían registrar movimientos sin validar el cierre de mes.
do $$
declare f record;
begin
  for f in
    select oid::regprocedure as firma from pg_proc
    where pronamespace = 'public'::regnamespace
      and (proname in ('rpc_registrar_entrada', 'rpc_registrar_salida')
           or (proname = 'fn_verificar_periodo_abierto'
               and pg_get_function_identity_arguments(oid) like '%timestamp%'))
  loop
    execute format('drop function %s', f.firma);
  end loop;
end $$;

-- ============================================================================
-- Fin de actualizar_base.sql
-- ============================================================================
