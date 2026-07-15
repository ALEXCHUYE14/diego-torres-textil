import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!url || !anonKey) {
  // createClient('', '', ...) lanza una excepción síncrona apenas se
  // importa este módulo (antes de que React monte nada), dejando una
  // pantalla en blanco sin ninguna pista visible. Se muestra un mensaje
  // claro directo en el DOM y se detiene la carga, en vez de dejar que el
  // error crudo de la librería reviente en silencio.
  const mensaje = 'Error de configuración: faltan las variables VITE_SUPABASE_URL y/o VITE_SUPABASE_ANON_KEY. Contacte al administrador del sistema.';
  console.error('[Comercializadora T&E] ' + mensaje);
  document.body.innerHTML = `
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;padding:24px;text-align:center;background:#1e2430;color:#fff;">
      <div style="max-width:420px;">
        <p style="font-size:18px;font-weight:700;margin-bottom:8px;">No se pudo iniciar el sistema</p>
        <p style="font-size:14px;color:#c7cbd4;">${mensaje}</p>
      </div>
    </div>`;
  throw new Error(mensaje);
}

export const supabase = createClient(url, anonKey, {
  auth: { persistSession: true, autoRefreshToken: true },
});

// Supabase/PostgREST tapa en 1000 filas cualquier consulta que no traiga su
// propio límite — un simple `.select('*')` sobre una tabla que ya superó esa
// cantidad de filas devuelve solo las primeras 1000 (según el orden pedido),
// sin ningún aviso de que quedó algo afuera. Esta función arma páginas de
// `rangoPagina` filas con `.range()` y las va concatenando hasta que una
// página vuelve vacía, así que siempre trae la tabla completa sin importar
// cuánto haya crecido el catálogo. `desde += filas.length` (el conteo real
// recibido, no el pedido) hace que esto siga siendo correcto aunque el
// servidor aplique un tope propio más chico que `rangoPagina`.
export async function obtenerTodasLasFilas<T>(
  construirConsulta: (desde: number, hasta: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  rangoPagina = 1000
): Promise<T[]> {
  let desde = 0;
  let resultado: T[] = [];
  for (;;) {
    const { data, error } = await construirConsulta(desde, desde + rangoPagina - 1);
    if (error) throw new Error(error.message);
    const filas = data ?? [];
    if (filas.length === 0) break;
    resultado = resultado.concat(filas);
    desde += filas.length;
  }
  return resultado;
}
