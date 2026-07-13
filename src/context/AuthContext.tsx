import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { Rol } from '../lib/types';
import { borrarTodosLosBorradores } from '../utils/borrador';
import { useToast } from './ToastContext';

interface AuthCtx {
  session: Session | null;
  rol: Rol;
  nombre: string;
  cargando: boolean;
  /** Puede escribir: crear artículos, registrar entradas/salidas (Operativo o Administrador). */
  esOperativo: boolean;
  /** Control total: eliminar artículos, gestionar usuarios, cerrar/abrir meses. */
  esAdministrador: boolean;
  salir: () => Promise<void>;
}

const Ctx = createContext<AuthCtx>({
  session: null, rol: 'consulta', nombre: '', cargando: true,
  esOperativo: false, esAdministrador: false, salir: async () => {},
});
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const { toast } = useToast();
  const [session, setSession] = useState<Session | null>(null);
  const [rol, setRol] = useState<Rol>('consulta');
  const [nombre, setNombre] = useState('');
  const [cargandoSesion, setCargandoSesion] = useState(true);
  const [perfilListo, setPerfilListo] = useState(false);

  useEffect(() => {
    supabase.auth.getSession()
      .then(({ data }) => {
        setSession(data.session);
        setCargandoSesion(false);
      })
      // Sin este .catch(), un rechazo de esta promesa (ej. una falla de red
      // durante la carga inicial) dejaba cargandoSesion en `true` para
      // siempre — la pantalla de carga nunca se soltaba, sin ningún mensaje
      // visible de qué pasó.
      .catch(() => setCargandoSesion(false));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    // Espera a que getSession() resuelva antes de decidir nada: `session`
    // arranca en `null` por defecto, igual que cuando de verdad no hay
    // sesión — sin este guard, este efecto corría en el primer render con
    // ese `null` todavía sin confirmar, marcaba perfilListo=true de
    // inmediato (con rol='consulta') y dejaba una ventana de un render
    // donde `cargando` ya daba false pero el rol real (ej. administrador)
    // aún no había llegado. En esa ventana, RutaProtegida llegaba a
    // rechazar rutas que sí debían estar permitidas.
    if (cargandoSesion) return;
    if (!session) { setRol('consulta'); setNombre(''); setPerfilListo(true); return; }
    // Bandera de cancelación: si la sesión cambia (logout/login rápido de otro
    // usuario) antes de que esta consulta resuelva, se descarta su resultado
    // para no mezclar el rol/nombre de una sesión con datos de otra.
    let vigente = true;
    setPerfilListo(false);
    (async () => {
      try {
        const { data, error } = await supabase
          .from('usuarios')
          .select('rol, nombre')
          .eq('id_usuario', session.user.id)
          .maybeSingle();
        if (!vigente) return;
        if (error) {
          toast('error', 'No se pudo verificar el rol del usuario. Reintentando al recargar.');
          setNombre(session.user.email ?? '');
          return;
        }
        if (data) {
          setRol((data.rol as Rol) ?? 'consulta');
          setNombre(data.nombre ?? session.user.email ?? '');
        } else {
          setNombre(session.user.email ?? '');
        }
      } catch {
        if (!vigente) return;
        toast('error', 'Error de red al verificar el rol del usuario.');
        setNombre(session.user.email ?? '');
      } finally {
        if (vigente) setPerfilListo(true);
      }
    })();
    return () => { vigente = false; };
    // Depende del id de usuario (no del objeto `session` completo): Supabase
    // entrega una referencia nueva de `session` en cada refresco automático
    // de token aunque sea el mismo usuario, y sin esto se repetía la consulta
    // de rol/nombre innecesariamente en cada refresco.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user.id, cargandoSesion, toast]);

  const salir = async () => {
    try {
      await supabase.auth.signOut();
    } finally {
      borrarTodosLosBorradores();
    }
  };

  // La pantalla de carga cubre tanto la resolución de sesión como la del
  // perfil (rol/nombre) en la carga inicial, para que el panel nunca se
  // muestre por un instante con el rol equivocado. En refrescos posteriores
  // de token (mismo usuario) `perfilListo` ya está en true y no vuelve a
  // interrumpir al usuario con la pantalla de carga.
  const cargando = cargandoSesion || (!!session && !perfilListo);

  // Administrador conserva todas las capacidades de Operativo (control
  // total), por eso esOperativo también es verdadero para administrador.
  const esAdministrador = rol === 'administrador';
  const esOperativo = rol === 'operativo' || esAdministrador;

  return (
    <Ctx.Provider value={{ session, rol, nombre, cargando, esOperativo, esAdministrador, salir }}>
      {children}
    </Ctx.Provider>
  );
}
