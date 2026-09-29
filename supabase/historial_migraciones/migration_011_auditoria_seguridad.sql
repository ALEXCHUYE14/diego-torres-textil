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
