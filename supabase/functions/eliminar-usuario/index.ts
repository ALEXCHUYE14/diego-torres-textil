// Edge Function: eliminar-usuario
// -----------------------------------------------------------------------------
// Elimina una cuenta (correo + contraseña) del sistema, SOLO si quien llama
// ya es Administrador. Igual que crear-usuario, esto requiere la clave
// "service_role" (auth.admin.deleteUser), que jamás debe llegar al código
// del navegador — por eso vive en el servidor.
//
// Reglas de negocio:
//  - Un Administrador no puede eliminarse a sí mismo (evita quedarse sin
//    acceso al panel de usuarios por accidente).
//  - No se puede eliminar un usuario que ya tiene movimientos, ventas o
//    cierres de mes registrados a su nombre: son referencias uuid en
//    historial_movimientos.usuario_id / ventas.usuario_id /
//    periodos_bloqueados.bloqueado_por SIN "on delete cascade", así que
//    intentar borrar el auth.users correspondiente fallaría con un error
//    de llave foránea de todos modos. Se valida antes, con un mensaje claro
//    en español, en vez de dejar que el navegador reciba un error crudo de
//    Postgres.
//
// Despliegue: `supabase functions deploy eliminar-usuario` (o pegar este
// archivo en el editor de Functions del dashboard de Supabase, nombrando la
// función exactamente "eliminar-usuario").
// -----------------------------------------------------------------------------

import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

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

  // 1) Verifica quién llama, usando SU PROPIO token.
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
  let body: { id_usuario?: string };
  try {
    body = await req.json();
  } catch {
    return respuesta({ error: 'Cuerpo de la petición inválido' }, 400);
  }

  const idUsuario = (body.id_usuario ?? '').trim();
  if (!idUsuario) {
    return respuesta({ error: 'Falta el identificador del usuario a eliminar' }, 400);
  }
  if (idUsuario === userData.user.id) {
    return respuesta({ error: 'No puede eliminar su propia cuenta desde aquí' }, 400);
  }

  const clienteAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: perfilObjetivo, error: perfilObjetivoError } = await clienteAdmin
    .from('usuarios')
    .select('id_usuario, nombre')
    .eq('id_usuario', idUsuario)
    .maybeSingle();
  if (perfilObjetivoError || !perfilObjetivo) {
    return respuesta({ error: 'El usuario a eliminar no existe' }, 404);
  }

  // 3) Bloquea el borrado si el usuario ya dejó rastro en el sistema.
  const [{ count: movs }, { count: ventas }, { count: cierres }] = await Promise.all([
    clienteAdmin.from('historial_movimientos').select('id_movimiento', { count: 'exact', head: true }).eq('usuario_id', idUsuario),
    clienteAdmin.from('ventas').select('id_venta', { count: 'exact', head: true }).eq('usuario_id', idUsuario),
    clienteAdmin.from('periodos_bloqueados').select('anio_mes', { count: 'exact', head: true }).eq('bloqueado_por', idUsuario),
  ]);

  if ((movs ?? 0) > 0 || (ventas ?? 0) > 0 || (cierres ?? 0) > 0) {
    return respuesta({
      error: `No se puede eliminar a ${perfilObjetivo.nombre}: ya tiene movimientos, ventas o cierres de mes registrados a su nombre en el sistema. Cambie su rol a Consulta si desea quitarle el acceso sin perder el historial.`,
    }, 400);
  }

  // 4) Elimina la cuenta. La fila de "usuarios" se borra sola por el
  //    "on delete cascade" de su llave foránea hacia auth.users.
  const { error: eliminarError } = await clienteAdmin.auth.admin.deleteUser(idUsuario);
  if (eliminarError) {
    return respuesta({ error: eliminarError.message || 'No se pudo eliminar el usuario' }, 400);
  }

  return respuesta({ ok: true, id_usuario: idUsuario }, 200);
});
