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
