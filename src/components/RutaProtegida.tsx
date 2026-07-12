import { ReactNode, useEffect, useRef } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { Rol } from '../lib/types';

/**
 * Bloquea una ruta a los roles indicados. Si el usuario actual no califica
 * (por ejemplo, Consulta escribiendo /entradas directamente en la URL), lo
 * redirige al inicio y muestra un aviso — no alcanza con ocultar el link del
 * menú, porque cualquiera puede escribir la URL a mano.
 */
export default function RutaProtegida({ rolesPermitidos, children }: { rolesPermitidos: Rol[]; children: ReactNode }) {
  const { rol } = useAuth();
  const { toast } = useToast();
  const avisado = useRef(false);
  const permitido = rolesPermitidos.includes(rol);

  useEffect(() => {
    if (!permitido && !avisado.current) {
      avisado.current = true;
      toast('error', 'Acceso denegado: su rol no tiene permiso para ver esta sección.');
    }
  }, [permitido, toast]);

  if (!permitido) return <Navigate to="/" replace />;
  return <>{children}</>;
}
