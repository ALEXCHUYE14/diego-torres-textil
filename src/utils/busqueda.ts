// Utilidades de búsqueda · usadas por el catálogo (Articulos.tsx, Maestro.tsx,
// filtrado en memoria) y espejadas en el servidor por fn_normalizar /
// rpc_buscar_productos (supabase/migration_013_busqueda_optimizada.sql) para
// que el buscador con autocompletado (BuscadorProducto) se comporte igual.
import { Producto } from '../lib/types';

const MAX_PALABRAS = 6;

/** MAYÚSCULAS + sin tildes/diacríticos + espacios colapsados. */
export function normalizarTexto(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

/** Parte el término de búsqueda en palabras normalizadas (máx. 6, descarta vacías). */
export function palabrasBusqueda(termino: string): string[] {
  const normalizado = normalizarTexto(termino);
  if (!normalizado) return [];
  return normalizado.split(' ').filter(Boolean).slice(0, MAX_PALABRAS);
}

/**
 * true si CADA palabra del término aparece en ALGÚN campo del producto
 * (nombre, código, género, color, talla, + los que se pasen en camposExtra).
 * No exige que todas las palabras estén en el mismo campo: "camisa azul m"
 * encuentra nombre="CAMISA MANGA LARGA", color="AZUL", talla="M".
 */
export function coincideProducto(
  producto: Pick<Producto, 'nombre' | 'codigo_barra' | 'genero' | 'color' | 'talla'>,
  termino: string,
  camposExtra: Array<string | null | undefined> = []
): boolean {
  const palabras = palabrasBusqueda(termino);
  if (palabras.length === 0) return true;

  const campos = [producto.nombre, producto.codigo_barra, producto.genero, producto.color, producto.talla, ...camposExtra]
    .filter((c): c is string => !!c && c.length > 0)
    .map(normalizarTexto);

  return palabras.every((palabra) => campos.some((campo) => campo.includes(palabra)));
}
