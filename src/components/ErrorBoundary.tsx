import { Component, ErrorInfo, ReactNode } from 'react';
import { RefreshCcw, TriangleAlert } from 'lucide-react';

interface Props { children: ReactNode }
interface State { error: Error | null }

/**
 * Última barrera ante un error de render inesperado (dato corrupto de una
 * respuesta RPC, etc). Sin esto, React desmonta todo el árbol y deja una
 * pantalla en blanco sin explicación. Nunca redirige a Login por su cuenta:
 * el usuario conserva el control y decide si recarga.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[Diego Torres] Error no controlado en la interfaz:', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="grid min-h-screen place-items-center bg-pizarra-50 px-4">
          <div className="dt-card w-full max-w-sm p-6 text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-borgona-50 text-borgona-600">
              <TriangleAlert size={22} />
            </div>
            <h3 className="text-[17px] font-bold text-pizarra-800">Ocurrió un problema inesperado</h3>
            <p className="mt-2 text-[14px] leading-relaxed text-pizarra-500">
              La pantalla no pudo mostrarse correctamente. Sus datos en Supabase están a salvo;
              solo es necesario recargar esta vista para continuar.
            </p>
            <button className="dt-btn dt-btn-primary mt-5 w-full" onClick={() => window.location.reload()}>
              <RefreshCcw size={17} /> Recargar
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
