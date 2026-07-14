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
  // Id del usuario para el que rol/nombre ya están cargados y son válidos
  // (null = sesión anónima o perfil aún no cargado). Comparar esto contra
  // session.user.id — en vez de un simple booleano "perfil listo" — es lo
  // que permite detectar, en el MISMO render donde `session` cambia de
  // usuario (ej. justo al iniciar sesión), que el rol todavía no
  // corresponde a ese usuario. Un booleano aparte solo se corrige en un
  // efecto que corre DESPUÉS de ese render, dejando una ventana donde
  // `cargando` ya da false pero `rol` todavía es el de antes de iniciar
  // sesión ("consulta" por defecto) — exactamente lo que dejaba pasar el
  // aviso falso de "acceso denegado" al entrar como Administrador.
  const [perfilCargadoPara, setPerfilCargadoPara] = useState<string | null>(null);

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
    if (!session) { setRol('consulta'); setNombre(''); setPerfilCargadoPara(null); return; }
    // Bandera de cancelación: si la sesión cambia (logout/login rápido de otro
    // usuario) antes de que esta consulta resuelva, se descarta su resultado
    // para no mezclar el rol/nombre de una sesión con datos de otra.
    let vigente = true;
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
        if (vigente) setPerfilCargadoPara(session.user.id);
      }
    })();
    return () => { vigente = false; };
    // Depende del id de usuario (no del objeto `session` completo): Supabase
    // entrega una referencia nueva de `session` en cada refresco automático
    // de token aunque sea el mismo usuario, y sin esto se repetía la consulta
    // de rol/nombre innecesariamente en cada refresco.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user.id, toast]);

  const salir = async () => {
    try {
      await supabase.auth.signOut();
    } finally {
      borrarTodosLosBorradores();
    }
  };

  // La pantalla de carga cubre tanto la resolución de sesión como la del
  // perfil (rol/nombre): mientras el usuario de la sesión actual no
  // coincida con el usuario para el que ya se cargó el perfil, se sigue
  // mostrando "cargando" — sin ventanas intermedias con datos de otro
  // usuario. En refrescos de token (mismo usuario) la comparación sigue
  // coincidiendo y no vuelve a interrumpir con la pantalla de carga.
  const cargando = cargandoSesion || (!!session && perfilCargadoPara !== session.user.id);

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
