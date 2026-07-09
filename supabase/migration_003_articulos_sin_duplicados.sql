-- ============================================================================
--  DIEGO TORRES · Migración 003
--  Ejecutar completo en el SQL Editor de Supabase (después de schema.sql
--  y migration_002_cierre_mes_y_ajustes.sql).
--
--  Problema que corrige:
--   rpc_crear_articulo no tenía protección contra duplicados si dos usuarios
--   creaban simultáneamente el mismo artículo nuevo (mismo nombre, género,
--   color, talla y familia). El bloqueo de fila sobre "familias" evita que
--   choquen los CÓDIGOS (codigo_barra siempre queda único), pero no evita que
--   se creen dos filas distintas describiendo el mismo artículo lógico.
--
--  Solución:
--   1. Índice único parcial en productos: (id_familia, nombre, genero, color,
--      talla) — solo entre artículos ACTIVOS. "Parcial" (where activo) para
--      poder volver a crear un artículo con los mismos atributos después de
--      haber sido eliminado (activo=false), que es el comportamiento actual
--      del catálogo (baja lógica, no borrado físico).
--   2. rpc_crear_articulo ahora: (a) revisa primero si ya existe un artículo
--      activo idéntico y lo reutiliza sin gastar un consecutivo nuevo, y
--      (b) si aun así dos solicitudes chocan exactamente al mismo tiempo,
--      atrapa la violación de unicidad y reutiliza la fila que ganó la
--      carrera en vez de fallar o duplicar.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. ÍNDICE ÚNICO · un mismo artículo activo no puede existir dos veces
-- ----------------------------------------------------------------------------
create unique index if not exists uq_productos_atributos_activos
  on productos (id_familia, nombre, genero, color, talla)
  where activo;

-- ----------------------------------------------------------------------------
-- 2. rpc_crear_articulo · misma firma que en schema.sql, CREATE OR REPLACE
--    la reemplaza entera (no rompe a quien ya la invoca: mismos parámetros,
--    mismo formato de retorno json con id_producto y codigo_barra).
-- ----------------------------------------------------------------------------
create or replace function rpc_crear_articulo(
  p_id_familia    uuid,
  p_nombre        text,
  p_genero        text,
  p_color         text,
  p_talla         text,
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
  v_genero   text := upper(trim(p_genero));
  v_color    text := upper(trim(p_color));
  v_talla    text := upper(trim(p_talla));
begin
  if fn_rol_actual() <> 'operativo' then
    raise exception 'Permiso denegado: se requiere rol Operativo';
  end if;

  -- Camino rápido: si ya existe un artículo activo con exactamente estos
  -- atributos, se reutiliza y no se gasta un consecutivo nuevo de la familia.
  select * into v_producto from productos
  where id_familia = p_id_familia and activo
    and nombre = v_nombre and genero = v_genero and color = v_color and talla = v_talla
  limit 1;
  if found then
    return json_build_object(
      'id_producto', v_producto.id_producto,
      'codigo_barra', v_producto.codigo_barra,
      'ya_existia', true
    );
  end if;

  -- Bloqueo pesimista del contador de la familia (anti-colisión concurrente)
  select * into v_fam from familias where id_familia = p_id_familia for update;
  if not found then raise exception 'Familia no encontrada'; end if;

  update familias set consecutivo_familia = consecutivo_familia + 1
  where id_familia = p_id_familia
  returning * into v_fam;

  v_codigo := v_fam.codigo || '-' || lpad(v_fam.consecutivo_familia::text, 3, '0')
    || '-' || v_nombre || '-' || v_genero || '-' || v_color || '-' || v_talla;

  begin
    insert into productos (codigo_barra, nombre, genero, color, talla, id_familia,
      valor_unitario_inicial, ultimo_valor_unitario, costo_promedio_ponderado, precio_venta)
    values (v_codigo, v_nombre, v_genero, v_color, v_talla, p_id_familia,
      p_valor_inicial, p_valor_inicial, p_valor_inicial, p_precio_venta)
    returning * into v_producto;
  exception when unique_violation then
    -- Dos solicitudes llegaron al mismo tiempo para el mismo artículo nuevo:
    -- la que ganó la carrera ya insertó la fila: la reutilizamos en vez de
    -- fallar. (El consecutivo ya incrementado arriba queda como un pequeño
    -- salto en la numeración de la familia; no afecta la unicidad del código
    -- ni la integridad de los datos, es solo estético.)
    select * into v_producto from productos
    where id_familia = p_id_familia and activo
      and nombre = v_nombre and genero = v_genero and color = v_color and talla = v_talla
    limit 1;
    if not found then
      raise; -- era otra violación de unicidad distinta (ej. codigo_barra): no la ocultamos
    end if;
    return json_build_object(
      'id_producto', v_producto.id_producto,
      'codigo_barra', v_producto.codigo_barra,
      'ya_existia', true
    );
  end;

  return json_build_object(
    'id_producto', v_producto.id_producto,
    'codigo_barra', v_producto.codigo_barra,
    'ya_existia', false
  );
end $$;

-- ============================================================================
-- Fin de la migración 003.
-- ============================================================================
