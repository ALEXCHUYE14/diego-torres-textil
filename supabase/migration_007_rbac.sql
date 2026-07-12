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
update usuarios set rol = 'administrador' where rol = 'operativo';

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
