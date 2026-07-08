import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!url || !anonKey) {
  // Mensaje claro en consola durante la instalación del sistema
  console.warn('[Diego Torres] Configure VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY en el archivo .env');
}

export const supabase = createClient(url ?? '', anonKey ?? '', {
  auth: { persistSession: true, autoRefreshToken: true },
});
