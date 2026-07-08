-- ============================================================================
--  DIEGO TORRES · Sistema Textil (Inventario + POS + CRM)
--  Schema PostgreSQL para Supabase — ejecutar completo en SQL Editor
--  Incluye: tablas, contadores anti-colisión, RPCs transaccionales con
--  bloqueo de stock, costo promedio ponderado (CPP), RLS por rol y seeds.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. TABLAS MAESTRAS
-- ----------------------------------------------------------------------------

create table if not exists familias (
  id_familia        uuid primary key default gen_random_uuid(),
  codigo            varchar(5) not null unique,          -- '01000', '02000'...
  nombre            text not null,
  consecutivo_familia integer not null default 0,        -- contador incremental por familia
  creado_en         timestamptz not null default now()
);

create table if not exists productos (
  id_producto              uuid primary key default gen_random_uuid(),
  codigo_barra             text not null unique,          -- 01000-012-BATA-HOMBRE-DRI-M
  nombre                   text not null,
  genero                   text not null check (genero in ('HOMBRE','MUJER','UNISEX','NINO','NINA')),
  color                    text not null,
  talla                    text not null,
  id_familia               uuid not null references familias(id_familia),
  stock_real               numeric(14,2) not null default 0 check (stock_real >= 0),
  costo_promedio_ponderado numeric(14,4) not null default 0,
  valor_unitario_inicial   numeric(14,2) not null default 0,
  ultimo_valor_unitario    numeric(14,2) not null default 0,
  precio_venta             numeric(14,2) not null default 0,
  activo                   boolean not null default true,
  fecha_creacion           timestamptz not null default now()
);
create index if not exists idx_productos_nombre on productos using gin (to_tsvector('spanish', nombre));
create index if not exists idx_productos_codigo on productos (codigo_barra);

create table if not exists terceros (
  id_proveedor  uuid primary key default gen_random_uuid(),
  nit_documento text not null unique,
  razon_social  text not null,
  correo        text,
  telefono      text,
  creado_en     timestamptz not null default now()
);

create table if not exists clientes (
  id_cliente    uuid primary key default gen_random_uuid(),
  documento     text not null unique,
  nombre        text not null,
  correo        text,
  telefono      text,
  notas         text,
  ultima_compra timestamptz,
  creado_en     timestamptz not null default now()
);

-- Perfil de usuario vinculado a auth.users. Roles: 'consulta' | 'operativo'
create table if not exists usuarios (
  id_usuario uuid primary key references auth.users(id) on delete cascade,
  nombre     text not null,
  rol        text not null default 'consulta' check (rol in ('consulta','operativo')),
  creado_en  timestamptz not null default now()
);

-- Contadores globales para consecutivos ENT / SAL / TCK (a prueba de concurrencia)
create table if not exists consecutivos (
  tipo   text primary key,           -- 'ENT' | 'SAL' | 'TCK'
  ultimo bigint not null default 0
);
insert into consecutivos (tipo, ultimo) values ('ENT',0),('SAL',0),('TCK',0)
on conflict (tipo) do nothing;

-- ----------------------------------------------------------------------------
-- 2. MOVIMIENTOS Y VENTAS
-- ----------------------------------------------------------------------------

create table if not exists historial_movimientos (
  id_movimiento    uuid primary key default gen_random_uuid(),
  tipo_consecutivo text not null unique,                 -- ENT000000001 / SAL000000001
  tipo_movimiento  text not null,                        -- 1000,1002,1007,1210 / 2000,2003
  naturaleza       text not null check (naturaleza in ('ENTRADA','SALIDA')),
  fecha_registro   timestamptz not null default now(),
  producto_id      uuid not null references productos(id_producto),
  cantidad         numeric(14,2) not null check (cantidad > 0),
  valor_unitario   numeric(14,4) not null,
  valor_total      numeric(14,2) not null,
  proveedor_id     uuid references terceros(id_proveedor),
  cliente_id       uuid references clientes(id_cliente),
  nro_factura      text,
  nro_orden        text,
  concepto         text,
  usuario_id       uuid references auth.users(id),
  stock_resultante numeric(14,2) not null
);
create index if not exists idx_mov_producto_fecha on historial_movimientos (producto_id, fecha_registro);
create index if not exists idx_mov_fecha on historial_movimientos (fecha_registro);
create index if not exists idx_mov_consecutivo on historial_movimientos (tipo_consecutivo);

create table if not exists ventas (
  id_venta      uuid primary key default gen_random_uuid(),
  nro_ticket    text not null unique,                    -- TCK000000001
  fecha         timestamptz not null default now(),
  cliente_id    uuid references clientes(id_cliente),
  subtotal      numeric(14,2) not null,
  total         numeric(14,2) not null,
  metodo_pago   text not null default 'EFECTIVO',
  usuario_id    uuid references auth.users(id)
);

create table if not exists venta_items (
  id_item        uuid primary key default gen_random_uuid(),
  venta_id       uuid not null references ventas(id_venta) on delete cascade,
  producto_id    uuid not null references productos(id_producto),
  descripcion    text not null,
  talla          text not null,
  color          text not null,
  cantidad       numeric(14,2) not null,
  valor_unitario numeric(14,2) not null,
  valor_total    numeric(14,2) not null
);

-- ----------------------------------------------------------------------------
-- 3. FUNCIONES AUXILIARES
-- ----------------------------------------------------------------------------

-- Consecutivo global con bloqueo de fila: evita colisiones entre usuarios
create or replace function fn_siguiente_consecutivo(p_tipo text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare v_num bigint;
begin
  update consecutivos set ultimo = ultimo + 1
  where tipo = p_tipo
  returning ultimo into v_num;
  if v_num is null then
    raise exception 'Tipo de consecutivo % no existe', p_tipo;
  end if;
  return p_tipo || lpad(v_num::text, 9, '0');
end $$;

-- Rol del usuario autenticado
create or replace function fn_rol_actual()
returns text
language sql
security definer
stable
set search_path = public
as $$
  select coalesce((select rol from usuarios where id_usuario = auth.uid()), 'consulta');
$$;

-- ----------------------------------------------------------------------------
-- 4. RPC · CODIFICACIÓN AUTOMÁTICA DE ARTÍCULOS (Módulo 2)
--    Estructura: [Familia]-[Consecutivo 3 díg.]-[NOMBRE]-[GENERO]-[COLOR]-[TALLA]
-- ----------------------------------------------------------------------------
create or replace function rpc_crear_articulo(
  p_id_familia   uuid,
  p_nombre       text,
  p_genero       text,
  p_color        text,
  p_talla        text,
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
begin
  if fn_rol_actual() <> 'operativo' then
    raise exception 'Permiso denegado: se requiere rol Operativo';
  end if;

  -- Bloqueo pesimista del contador de la familia (anti-colisión concurrente)
  select * into v_fam from familias where id_familia = p_id_familia for update;
  if not found then raise exception 'Familia no encontrada'; end if;

  update familias set consecutivo_familia = consecutivo_familia + 1
  where id_familia = p_id_familia
  returning * into v_fam;

  v_codigo := v_fam.codigo || '-' || lpad(v_fam.consecutivo_familia::text, 3, '0')
    || '-' || upper(trim(p_nombre))
    || '-' || upper(trim(p_genero))
    || '-' || upper(trim(p_color))
    || '-' || upper(trim(p_talla));

  insert into productos (codigo_barra, nombre, genero, color, talla, id_familia,
    valor_unitario_inicial, ultimo_valor_unitario, costo_promedio_ponderado, precio_venta)
  values (v_codigo, upper(trim(p_nombre)), upper(trim(p_genero)), upper(trim(p_color)),
    upper(trim(p_talla)), p_id_familia, p_valor_inicial, p_valor_inicial, p_valor_inicial, p_precio_venta)
  returning * into v_producto;

  return json_build_object('id_producto', v_producto.id_producto, 'codigo_barra', v_producto.codigo_barra);
end $$;

-- ----------------------------------------------------------------------------
-- 5. RPC · ENTRADAS (RE-01) con Costo Promedio Ponderado
-- ----------------------------------------------------------------------------
create or replace function rpc_registrar_entrada(
  p_producto_id     uuid,
  p_tipo_movimiento text,
  p_cantidad        numeric,
  p_valor_unitario  numeric,
  p_proveedor_id    uuid,
  p_nro_factura     text default null,
  p_nro_orden       text default null,
  p_concepto        text default null,
  p_fecha           date default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prod        productos%rowtype;
  v_consecutivo text;
  v_nuevo_cpp   numeric;
  v_nuevo_stock numeric;
  v_fecha       timestamptz;
begin
  if fn_rol_actual() <> 'operativo' then
    raise exception 'Permiso denegado: se requiere rol Operativo';
  end if;
  if p_cantidad <= 0 then raise exception 'La cantidad debe ser mayor a 0'; end if;
  if p_valor_unitario < 0 then raise exception 'El valor unitario no puede ser negativo'; end if;
  if p_tipo_movimiento not in ('1000','1002','1007','1210') then
    raise exception 'Tipo de movimiento de entrada no autorizado';
  end if;

  -- Calendario restringido al mes/año actual del servidor
  v_fecha := coalesce(p_fecha::timestamptz, now());
  if date_trunc('month', v_fecha) <> date_trunc('month', now()) then
    raise exception 'La fecha debe pertenecer al mes y año actual';
  end if;

  select * into v_prod from productos where id_producto = p_producto_id for update;
  if not found then raise exception 'Producto no encontrado'; end if;

  v_nuevo_stock := v_prod.stock_real + p_cantidad;
  -- CPP = (stock*cpp + cantidad*valor) / (stock + cantidad)
  v_nuevo_cpp := case when v_nuevo_stock = 0 then p_valor_unitario
    else round(((v_prod.stock_real * v_prod.costo_promedio_ponderado)
              + (p_cantidad * p_valor_unitario)) / v_nuevo_stock, 4) end;

  update productos set
    stock_real = v_nuevo_stock,
    costo_promedio_ponderado = v_nuevo_cpp,
    ultimo_valor_unitario = p_valor_unitario
  where id_producto = p_producto_id;

  v_consecutivo := fn_siguiente_consecutivo('ENT');

  insert into historial_movimientos (tipo_consecutivo, tipo_movimiento, naturaleza,
    fecha_registro, producto_id, cantidad, valor_unitario, valor_total,
    proveedor_id, nro_factura, nro_orden, concepto, usuario_id, stock_resultante)
  values (v_consecutivo, p_tipo_movimiento, 'ENTRADA', v_fecha, p_producto_id,
    p_cantidad, p_valor_unitario, round(p_cantidad * p_valor_unitario, 2),
    p_proveedor_id, p_nro_factura, p_nro_orden, p_concepto, auth.uid(), v_nuevo_stock);

  return json_build_object('consecutivo', v_consecutivo, 'nuevo_stock', v_nuevo_stock, 'nuevo_cpp', v_nuevo_cpp);
end $$;

-- ----------------------------------------------------------------------------
-- 6. RPC · SALIDAS (RE-02) — bloqueo de stock, prohíbe negativos, valor = CPP
-- ----------------------------------------------------------------------------
create or replace function rpc_registrar_salida(
  p_producto_id     uuid,
  p_tipo_movimiento text,
  p_cantidad        numeric,
  p_cliente_id      uuid default null,
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
  v_prod        productos%rowtype;
  v_consecutivo text;
  v_nuevo_stock numeric;
begin
  if fn_rol_actual() <> 'operativo' then
    raise exception 'Permiso denegado: se requiere rol Operativo';
  end if;
  if p_cantidad <= 0 then raise exception 'La cantidad debe ser mayor a 0'; end if;
  if p_tipo_movimiento not in ('2000','2003') then
    raise exception 'Tipo de movimiento de salida no autorizado';
  end if;

  select * into v_prod from productos where id_producto = p_producto_id for update;
  if not found then raise exception 'Producto no encontrado'; end if;

  if p_cantidad > v_prod.stock_real then
    raise exception 'STOCK_INSUFICIENTE: disponible %, solicitado %', v_prod.stock_real, p_cantidad;
  end if;

  v_nuevo_stock := v_prod.stock_real - p_cantidad;
  update productos set stock_real = v_nuevo_stock where id_producto = p_producto_id;

  v_consecutivo := fn_siguiente_consecutivo('SAL');

  insert into historial_movimientos (tipo_consecutivo, tipo_movimiento, naturaleza,
    fecha_registro, producto_id, cantidad, valor_unitario, valor_total,
    cliente_id, nro_factura, nro_orden, concepto, usuario_id, stock_resultante)
  values (v_consecutivo, p_tipo_movimiento, 'SALIDA', now(), p_producto_id,
    p_cantidad, v_prod.costo_promedio_ponderado,
    round(p_cantidad * v_prod.costo_promedio_ponderado, 2),
    p_cliente_id, p_nro_factura, p_nro_orden, p_concepto, auth.uid(), v_nuevo_stock);

  return json_build_object('consecutivo', v_consecutivo, 'nuevo_stock', v_nuevo_stock,
    'valor_unitario', v_prod.costo_promedio_ponderado);
end $$;

-- ----------------------------------------------------------------------------
-- 7. RPC · VENTA POS (Módulo 3) — transaccional multi-ítem con ticket
-- ----------------------------------------------------------------------------
create or replace function rpc_registrar_venta(
  p_items       jsonb,               -- [{producto_id, cantidad}]
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
begin
  if fn_rol_actual() <> 'operativo' then
    raise exception 'Permiso denegado: se requiere rol Operativo';
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

    insert into historial_movimientos (tipo_consecutivo, tipo_movimiento, naturaleza,
      fecha_registro, producto_id, cantidad, valor_unitario, valor_total,
      cliente_id, concepto, usuario_id, stock_resultante)
    values (fn_siguiente_consecutivo('SAL'), '2000', 'SALIDA', now(), v_prod.id_producto,
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
-- 8. RPC · KARDEX Y DETALLE DE PRODUCTO (Módulo 4)
--    modo: 'MES' | 'ANIO' | 'HISTORICO' (+ p_anio para histórico)
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
    select m.tipo_consecutivo, m.tipo_movimiento, m.naturaleza, m.fecha_registro,
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

create or replace function rpc_detalle_producto(p_producto_id uuid)
returns json
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_prod          productos%rowtype;
  v_ent_mes       numeric := 0;
  v_sal_mes       numeric := 0;
  v_stock_inicial numeric := 0;
  v_consumo_prom  numeric := 0;
  v_duracion      numeric := 0;
begin
  select * into v_prod from productos where id_producto = p_producto_id;
  if not found then return null; end if;

  select coalesce(sum(cantidad) filter (where naturaleza='ENTRADA'),0),
         coalesce(sum(cantidad) filter (where naturaleza='SALIDA'),0)
  into v_ent_mes, v_sal_mes
  from historial_movimientos
  where producto_id = p_producto_id
    and fecha_registro >= date_trunc('month', now());

  v_stock_inicial := v_prod.stock_real - v_ent_mes + v_sal_mes;

  -- Consumo promedio diario (últimos 90 días) y cobertura en días
  select coalesce(sum(cantidad),0) / 90.0 into v_consumo_prom
  from historial_movimientos
  where producto_id = p_producto_id and naturaleza='SALIDA'
    and fecha_registro >= now() - interval '90 days';
  v_duracion := case when v_consumo_prom > 0 then round(v_prod.stock_real / v_consumo_prom, 1) else 0 end;

  return json_build_object(
    'producto', row_to_json(v_prod),
    'stock_inicial', v_stock_inicial,
    'entradas_mes', v_ent_mes,
    'salidas_mes', v_sal_mes,
    'consumo_promedio', round(v_consumo_prom, 2),
    'duracion_dias', v_duracion,
    'existencias', v_prod.stock_real,
    'valorizacion', round(v_prod.stock_real * v_prod.costo_promedio_ponderado, 2),
    'valor_ajustable', round(v_prod.stock_real * v_prod.valor_unitario_inicial, 2),
    'valor_reposicion', round(v_prod.stock_real * v_prod.ultimo_valor_unitario, 2),
    'valor_actual', v_prod.costo_promedio_ponderado
  );
end $$;

-- ----------------------------------------------------------------------------
-- 9. RPC · INFORME DE CIERRE (Módulo 5)
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
  from productos where activo;

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
  where p.activo;

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
  from productos where activo order by stock_real desc limit 1;

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
    where p.activo
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
-- 10. RPC · DOCUMENTO PARA IMPRESIÓN CENTRALIZADA (Módulo 6)
-- ----------------------------------------------------------------------------
create or replace function rpc_obtener_documento(p_tipo text, p_numero text)
returns json
language plpgsql
security definer
stable
set search_path = public
as $$
declare v_doc json;
begin
  if p_tipo = 'FACTURA_VENTA' then
    select json_build_object(
      'venta', row_to_json(v),
      'cliente', row_to_json(c),
      'items', (select coalesce(json_agg(row_to_json(i)), '[]'::json)
                from venta_items i where i.venta_id = v.id_venta))
    into v_doc
    from ventas v left join clientes c on c.id_cliente = v.cliente_id
    where v.nro_ticket = p_numero;
  else
    select json_build_object(
      'movimiento', row_to_json(m),
      'producto', row_to_json(p),
      'proveedor', row_to_json(ter))
    into v_doc
    from historial_movimientos m
    join productos p on p.id_producto = m.producto_id
    left join terceros ter on ter.id_proveedor = m.proveedor_id
    where m.tipo_consecutivo = p_numero;
  end if;
  return v_doc;
end $$;

-- ----------------------------------------------------------------------------
-- 11. SEGURIDAD RLS · rol 'consulta' = solo lectura, 'operativo' = escritura
-- ----------------------------------------------------------------------------
alter table familias enable row level security;
alter table productos enable row level security;
alter table terceros enable row level security;
alter table clientes enable row level security;
alter table usuarios enable row level security;
alter table historial_movimientos enable row level security;
alter table ventas enable row level security;
alter table venta_items enable row level security;
alter table consecutivos enable row level security;

do $$
declare t text;
begin
  foreach t in array array['familias','productos','terceros','clientes',
    'historial_movimientos','ventas','venta_items'] loop
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

drop policy if exists sel_usuarios on usuarios;
create policy sel_usuarios on usuarios for select to authenticated using (true);
drop policy if exists upsert_propio on usuarios;
create policy upsert_propio on usuarios for insert to authenticated with check (id_usuario = auth.uid());

-- Trigger: crear perfil 'consulta' al registrarse un usuario nuevo
-- set search_path es obligatorio aquí: supabase_auth_admin (quien dispara este
-- trigger al crear el usuario en auth.users) usa una ruta de búsqueda que NO
-- incluye 'public' por defecto; sin esta línea, "usuarios" no se resuelve y
-- la creación del usuario falla con "Database error creating new user".
create or replace function fn_nuevo_usuario()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.usuarios (id_usuario, nombre, rol)
  values (new.id, coalesce(new.raw_user_meta_data->>'nombre', split_part(new.email,'@',1)), 'consulta')
  on conflict (id_usuario) do nothing;
  return new;
end $$;
drop trigger if exists trg_nuevo_usuario on auth.users;
create trigger trg_nuevo_usuario after insert on auth.users
for each row execute function fn_nuevo_usuario();

-- ----------------------------------------------------------------------------
-- 12. SEEDS · Familias textiles (codificación estricta) y proveedores demo
-- ----------------------------------------------------------------------------
insert into familias (codigo, nombre) values
  ('01000','BIOSEGURIDAD'), ('02000','BLUSA'), ('03000','BUSO'),
  ('04000','CAMISA'), ('05000','CAMISETA'), ('06000','CHAQUETA'),
  ('07000','FALDA'), ('08000','JEAN'), ('09000','PANTALON'),
  ('10000','POLO'), ('11000','SHORT'), ('12000','VESTIDO'),
  ('13000','BATA'), ('14000','OVEROL'), ('15000','UNIFORME')
on conflict (codigo) do nothing;

insert into terceros (nit_documento, razon_social, correo, telefono) values
  ('20601234567','TEXTILES DEL NORTE S.A.C.','ventas@textilnorte.pe','073-345678'),
  ('20459876543','HILADOS PIURA E.I.R.L.','contacto@hiladospiura.pe','073-221144'),
  ('10467891234','CONFECCIONES LUCERO','lucero.confec@gmail.com','987654321')
on conflict (nit_documento) do nothing;

-- Para asignar rol operativo a un usuario (tras crear su cuenta):
-- update usuarios set rol = 'operativo' where id_usuario = 'UUID_DEL_USUARIO';
