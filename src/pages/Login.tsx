import { FormEvent, useState } from 'react';
import { Eye, EyeOff, Loader2, LogIn, MessageCircle, ShieldCheck } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useToast } from '../context/ToastContext';

const WHATSAPP_SOPORTE = 'https://wa.me/51924996961?text=' +
  encodeURIComponent('Hola, necesito ayuda para ingresar al sistema Diego Torres Textil.');

const CARACTERISTICAS = [
  'Costo promedio ponderado calculado en tiempo real',
  'Trazabilidad completa por kardex y consecutivos',
  'Cierre de mes con bloqueo estricto de períodos',
];

export default function Login() {
  const { toast } = useToast();
  const [correo, setCorreo] = useState('');
  const [clave, setClave] = useState('');
  const [verClave, setVerClave] = useState(false);
  const [cargando, setCargando] = useState(false);

  const entrar = async (e: FormEvent) => {
    e.preventDefault();
    setCargando(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({ email: correo, password: clave });
      if (error) toast('error', 'Credenciales inválidas. Verifique correo y contraseña.');
    } catch {
      toast('error', 'Error de red al iniciar sesión. Verifique su conexión e intente nuevamente.');
    } finally {
      setCargando(false);
    }
  };

  return (
    <div className="grid min-h-screen bg-hilo md:grid-cols-2">
      {/* ================= Panel de marca (oculto en móvil: solo el login, sin imagen superior) ================= */}
      <div className="relative hidden overflow-hidden bg-pizarra-800 px-8 py-12 md:flex md:flex-col md:items-center md:justify-center md:py-16">
        {/* Resplandor decorativo de fondo */}
        <div className="pointer-events-none absolute -left-24 -top-24 h-72 w-72 rounded-full bg-indigo-600/20 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-28 -right-16 h-80 w-80 rounded-full bg-borgona-600/10 blur-3xl" />
        <div className="costura-vertical absolute right-0 top-0 bottom-0 hidden opacity-20 md:block" />

        <div className="login-in relative w-full max-w-xs text-center">
          <div className="mx-auto grid h-28 w-28 place-items-center rounded-full bg-white p-3 shadow-sastre-lg ring-1 ring-white/10 md:h-36 md:w-36">
            <img
              src="/img/logo.png"
              alt="Comercializadora T&E S.A.S."
              width={577}
              height={579}
              className="h-full w-full object-contain"
            />
          </div>

          <h1 className="mt-6 text-[28px] font-extrabold tracking-tight text-white md:text-[32px]">Diego Torres S.A.S.</h1>
          <p className="mt-1.5 text-[12.5px] uppercase tracking-[0.22em] text-pizarra-400">Inventario · Kardex · Cierre Contable</p>
          <p className="mt-1 text-[11px] uppercase tracking-[0.16em] text-pizarra-500">Comercializadora T&amp;E S.A.S.</p>

          <div className="costura my-7 opacity-30" />

          <ul className="space-y-3 text-left">
            {CARACTERISTICAS.map((texto) => (
              <li key={texto} className="flex items-start gap-2.5 text-[13px] leading-snug text-pizarra-300">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-500" />
                {texto}
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* ================= Panel de acceso (pantalla completa en móvil, derecha en escritorio) ================= */}
      <div className="flex min-h-screen items-center justify-center px-5 [padding-top:max(2.5rem,env(safe-area-inset-top))] [padding-bottom:max(2.5rem,env(safe-area-inset-bottom))] sm:px-6 md:min-h-0 md:px-4 md:[padding-top:4rem] md:[padding-bottom:4rem]">
        <div className="login-in login-in-delay w-full max-w-sm">
          <div className="mb-7 text-center md:text-left">
            <h2 className="text-[22px] font-extrabold tracking-tight text-pizarra-800">Ingresar al sistema</h2>
            <p className="mt-1 text-[13.5px] text-pizarra-500">Acceda con las credenciales asignadas por su administrador</p>
          </div>

          <form onSubmit={entrar} className="dt-card p-6 shadow-sastre-lg">
            {/* Logo dentro del marco: solo en móvil/tablet — en escritorio ya se ve
                el logo grande del panel izquierdo, mostrar ambos sería redundante. */}
            <div className="mb-5 flex justify-center md:hidden">
              <div className="grid h-20 w-20 place-items-center rounded-full bg-white p-2.5 shadow-sastre ring-1 ring-pizarra-100">
                <img
                  src="/img/logo.png"
                  alt="Comercializadora T&E S.A.S."
                  className="h-full w-full object-contain"
                />
              </div>
            </div>

            <label className="dt-label" htmlFor="correo">Correo</label>
            <input id="correo" type="email" required className="dt-input" value={correo}
              onChange={(e) => setCorreo(e.target.value)} placeholder="usuario@diegotorres.pe"
              autoComplete="email" autoFocus />

            <label className="dt-label mt-4" htmlFor="clave">Contraseña</label>
            <div className="relative">
              <input
                id="clave" type={verClave ? 'text' : 'password'} required
                className="dt-input !pr-11" value={clave}
                onChange={(e) => setClave(e.target.value)} placeholder="••••••••"
                autoComplete="current-password"
              />
              <button
                type="button"
                onClick={() => setVerClave((v) => !v)}
                className="absolute right-1.5 top-1/2 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-lg text-pizarra-400 transition hover:bg-pizarra-100 hover:text-pizarra-700"
                aria-label={verClave ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                tabIndex={-1}
              >
                {verClave ? <EyeOff size={17} /> : <Eye size={17} />}
              </button>
            </div>

            <button type="submit" disabled={cargando} className="dt-btn dt-btn-primary mt-6 w-full !py-3">
              {cargando ? <Loader2 size={17} className="animate-spin" /> : <LogIn size={17} />}
              {cargando ? 'Ingresando…' : 'Ingresar al sistema'}
            </button>

            <p className="mt-4 flex items-center justify-center gap-1.5 text-[11.5px] text-pizarra-400 md:justify-start">
              <ShieldCheck size={13} className="text-emerald-600" /> Conexión cifrada · acceso auditado
            </p>
          </form>

          <p className="mt-5 text-center text-[12px] text-pizarra-500 md:text-left">
            Acceso restringido · Roles Consulta y Administrador
          </p>

          <a
            href={WHATSAPP_SOPORTE}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-6 flex items-center justify-center gap-2.5 rounded-[10px] border border-pizarra-200 bg-white px-4 py-3 text-[13.5px] font-medium text-pizarra-600 shadow-sastre transition hover:-translate-y-0.5 hover:border-emerald-300 hover:shadow-sastre-lg hover:text-pizarra-800 md:justify-start"
          >
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-emerald-50 text-emerald-600">
              <MessageCircle size={15} />
            </span>
            ¿Problemas para ingresar? Contactar al soporte
          </a>
        </div>
      </div>
    </div>
  );
}
