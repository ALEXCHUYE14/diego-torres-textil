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
