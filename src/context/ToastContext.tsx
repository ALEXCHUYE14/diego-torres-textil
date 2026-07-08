import { createContext, useCallback, useContext, useState, ReactNode } from 'react';
import { CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';

type Tipo = 'exito' | 'error' | 'aviso';
interface Toast { id: number; tipo: Tipo; mensaje: string; }
interface ToastCtx { toast: (tipo: Tipo, mensaje: string) => void; }

const Ctx = createContext<ToastCtx>({ toast: () => {} });
export const useToast = () => useContext(Ctx);

let seq = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toast = useCallback((tipo: Tipo, mensaje: string) => {
    const id = ++seq;
    setToasts((t) => [...t, { id, tipo, mensaje }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);

  return (
    <Ctx.Provider value={{ toast }}>
      {children}
      <div className="fixed bottom-24 md:bottom-6 right-4 left-4 md:left-auto z-[90] flex flex-col gap-2 items-end pointer-events-none print:hidden">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={`toast-enter pointer-events-auto flex w-full md:w-auto md:max-w-md items-start gap-3 rounded-xl px-4 py-3 shadow-sastre-lg text-[14px] font-medium text-white ${
              t.tipo === 'exito' ? 'bg-emerald-600' : t.tipo === 'error' ? 'bg-red-600' : 'bg-amber-500'
            }`}
          >
            {t.tipo === 'exito' && <CheckCircle2 size={19} className="mt-0.5 shrink-0" />}
            {t.tipo === 'error' && <XCircle size={19} className="mt-0.5 shrink-0" />}
            {t.tipo === 'aviso' && <AlertTriangle size={19} className="mt-0.5 shrink-0" />}
            <span>{t.mensaje}</span>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
