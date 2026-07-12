// Edge Function: crear-usuario
// -----------------------------------------------------------------------------
// Crea una cuenta nueva (correo + contraseña) y le asigna un rol, SOLO si
// quien llama ya es Administrador. Esta operación no puede hacerse desde el
// navegador con la librería normal de Supabase: crear usuarios requiere la
// clave "service_role", que jamás debe llegar al código del cliente (con esa
// clave se puede saltar cualquier RLS de todo el proyecto). Por eso vive
// aquí, en el servidor, y el service_role key se lee de una variable de
// entorno que Supabase inyecta automáticamente en las Edge Functions — nunca
// se escribe en este archivo ni se expone al navegador.
//
// Despliegue: `supabase functions deploy crear-usuario` (o pegar este
// archivo en el editor de Functions del dashboard de Supabase).
// -----------------------------------------------------------------------------

import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const ROLES_ASIGNABLES = ['operativo', 'consulta'];

function respuesta(body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return respuesta({ error: 'Método no permitido' }, 405);
  }

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !ANON_KEY) {
    return respuesta({ error: 'Configuración incompleta del servidor' }, 500);
  }

  // 1) Verifica quién llama, usando SU PROPIO token (respeta RLS: no se
  //    confía en nada que venga del cuerpo de la petición para esto).
  const authHeader = req.headers.get('Authorization') ?? '';
  const clienteLlamador = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: userData, error: userError } = await clienteLlamador.auth.getUser();
  if (userError || !userData?.user) {
    return respuesta({ error: 'No autenticado' }, 401);
  }

  const { data: perfilLlamador, error: perfilError } = await clienteLlamador
    .from('usuarios')
    .select('rol')
    .eq('id_usuario', userData.user.id)
    .maybeSingle();

  if (perfilError || perfilLlamador?.rol !== 'administrador') {
    return respuesta({ error: 'Permiso denegado: se requiere rol Administrador' }, 403);
  }

  // 2) Valida la entrada
  let body: { correo?: string; clave?: string; nombre?: string; rol?: string };
  try {
    body = await req.json();
  } catch {
    return respuesta({ error: 'Cuerpo de la petición inválido' }, 400);
  }

  const correo = (body.correo ?? '').trim().toLowerCase();
  const clave = body.clave ?? '';
  const nombre = (body.nombre ?? '').trim();
  const rol = body.rol ?? '';

  if (!correo || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) {
    return respuesta({ error: 'Correo inválido' }, 400);
  }
  if (clave.length < 8) {
    return respuesta({ error: 'La contraseña debe tener al menos 8 caracteres' }, 400);
  }
  if (!nombre) {
    return respuesta({ error: 'El nombre es obligatorio' }, 400);
  }
  if (!ROLES_ASIGNABLES.includes(rol)) {
    return respuesta({ error: 'Rol inválido: solo se puede asignar Operativo o Consulta' }, 400);
  }

  // 3) Crea la cuenta con privilegios de servidor
  const clienteAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: nuevoUsuario, error: crearError } = await clienteAdmin.auth.admin.createUser({
    email: correo,
    password: clave,
    email_confirm: true,
    user_metadata: { nombre },
  });

  if (crearError || !nuevoUsuario?.user) {
    const msg = crearError?.message ?? 'No se pudo crear el usuario';
    const yaExiste = msg.toLowerCase().includes('already') || msg.toLowerCase().includes('registrad');
    return respuesta({ error: yaExiste ? 'Ya existe una cuenta con ese correo' : msg }, 400);
  }

  // 4) El trigger fn_nuevo_usuario ya insertó una fila en "usuarios" con
  //    rol 'consulta' por defecto — se actualiza al rol elegido.
  const { error: actualizarError } = await clienteAdmin
    .from('usuarios')
    .update({ nombre, rol })
    .eq('id_usuario', nuevoUsuario.user.id);

  if (actualizarError) {
    return respuesta({
      error: `Usuario creado pero no se pudo asignar el rol: ${actualizarError.message}`,
      id_usuario: nuevoUsuario.user.id,
    }, 500);
  }

  return respuesta({ id_usuario: nuevoUsuario.user.id, correo, nombre, rol }, 200);
});
