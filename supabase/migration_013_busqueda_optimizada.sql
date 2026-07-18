-- ============================================================================
--  DIEGO TORRES · Migración 013 — Motor de búsqueda unificado
--  Ejecutar en el SQL Editor de Supabase después de la migración 012.
--
--  Problema que corrige:
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
--  (fn_normalizar + rpc_buscar_productos) que:
--    1. Ignora tildes/diacríticos (extensión unaccent).
--    2. Ignora mayúsculas/minúsculas.
--    3. Colapsa espacios en blanco redundantes.
--    4. Busca por palabras: cada palabra escrita debe aparecer en ALGÚN
--       campo (nombre, código, género, color o talla), no necesariamente
--       todas en el mismo campo — así "camisa azul m" encuentra un artículo
--       con nombre "CAMISA MANGA LARGA", color "AZUL" y talla "M".
--    5. Usa un índice de trigramas (pg_trgm) sobre nombre y código para que
--       la búsqueda siga siendo rápida a medida que crece el catálogo.
--  El frontend (BuscadorProducto) pasa a llamar esta única RPC en vez de
--  construir el filtro `.or()` a mano.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Extensiones necesarias (ambas están en la lista de extensiones
--    permitidas de Supabase, no requieren privilegios especiales).
-- ----------------------------------------------------------------------------
create extension if not exists unaccent;
create extension if not exists pg_trgm;

-- ----------------------------------------------------------------------------
-- 2. fn_normalizar · MAYÚSCULAS + sin tildes, envuelta como IMMUTABLE.
--    unaccent(text) de por sí es STABLE (depende del diccionario de sesión),
--    lo cual impide usarla en un índice funcional. Fijar el diccionario
--    explícitamente a 'unaccent' vía unaccent(regdictionary, text) permite
--    marcar el envoltorio como IMMUTABLE de forma segura.
-- ----------------------------------------------------------------------------
create or replace function fn_normalizar(p_texto text)
returns text
language sql
immutable
parallel safe
as $$
  select upper(unaccent('unaccent'::regdictionary, coalesce(p_texto, '')));
$$;

-- ----------------------------------------------------------------------------
-- 3. Índices de trigramas sobre los campos normalizados más buscados
--    (nombre y código). género/color/talla son catálogos cerrados de pocos
--    valores (ver Catalogos.tsx): un filtro secuencial sobre ellos es
--    despreciable en costo, no necesitan índice propio.
-- ----------------------------------------------------------------------------
create index if not exists idx_productos_norm_nombre
  on productos using gin (fn_normalizar(nombre) gin_trgm_ops);
create index if not exists idx_productos_norm_codigo
  on productos using gin (fn_normalizar(codigo_barra) gin_trgm_ops);

-- ----------------------------------------------------------------------------
-- 4. rpc_buscar_productos · reemplaza el filtro `.or()` armado a mano en
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
set search_path = public
as $$
declare
  v_termino  text := trim(coalesce(p_termino, ''));
  v_palabras text[];
begin
  if length(v_termino) < 2 then
    return;
  end if;

  -- Colapsa espacios repetidos y parte en palabras (máx. 6, igual que el
  -- límite que antes aplicaba el cliente, para no admitir consultas
  -- arbitrariamente largas/costosas).
  select array_agg(w) into v_palabras
  from (
    select unnest(regexp_split_to_array(fn_normalizar(v_termino), '\s+')) as w
    limit 6
  ) s
  where w <> '';

  if v_palabras is null or array_length(v_palabras, 1) = 0 then
    return;
  end if;

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
  limit greatest(1, least(coalesce(p_limite, 8), 50));
end $$;

-- ============================================================================
-- Fin de la migración 013.
-- ============================================================================
