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
update consecutivos set ultimo = 0 where tipo in ('ENT','SAL');

-- ============================================================================
-- Fin de la migración 004.
-- ============================================================================
