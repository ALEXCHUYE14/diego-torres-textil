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
