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
  esOperativo: boolean;
  salir: () => Promise<void>;
}

const Ctx = createContext<AuthCtx>({
  session: null, rol: 'consulta', nombre: '', cargando: true,
  esOperativo: false, salir: async () => {},
});
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const { toast } = useToast();
  const [session, setSession] = useState<Session | null>(null);
  const [rol, setRol] = useState<Rol>('consulta');
  const [nombre, setNombre] = useState('');
  const [cargando, setCargando] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setCargando(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) { setRol('consulta'); setNombre(''); return; }
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
      }
    })();
    return () => { vigente = false; };
  }, [session, toast]);

  const salir = async () => {
    try {
      await supabase.auth.signOut();
    } finally {
      // Cierre de sesión controlado: se limpian los borradores locales para
      // que el próximo usuario del equipo no herede carritos ni formularios
      // a medio llenar de la sesión anterior.
      borrarTodosLosBorradores();
    }
  };

  return (
    <Ctx.Provider value={{ session, rol, nombre, cargando, esOperativo: rol === 'operativo', salir }}>
      {children}
    </Ctx.Provider>
  );
}
