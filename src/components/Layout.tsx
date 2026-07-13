import { ReactNode, useState } from 'react';
import { NavLink } from 'react-router-dom';
import {
  ArrowDownToLine, ArrowUpFromLine, LayoutDashboard, LibraryBig, LogOut,
  PackageSearch, PanelLeftClose, PanelLeftOpen, Printer, ScanBarcode, Search, Users,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { etiquetaRol } from '../lib/types';
import PrintModal from './PrintModal';

export default function Layout({ children }: { children: ReactNode }) {
  const [colapsado, setColapsado] = useState(false);
  const [printAbierto, setPrintAbierto] = useState(false);
  const { nombre, rol, esOperativo, esAdministrador, salir } = useAuth();

  // El menú se arma según el rol:
  //  - Informe, Maestro y Kardex: los 3 roles (Administrador, Operativo/
  //    Almacén y Consulta).
  //  - Entradas, Salidas, Artículos e Imprimir: Operativo/Almacén y
  //    Administrador.
  //  - Catálogos y Usuarios: exclusivos de Administrador.
  // No basta con ocultar el link — la ruta también está protegida (ver
  // RutaProtegida en App.tsx) para que escribir la URL a mano no sirva de
  // nada.
  const nav = [
    { a: '/', icono: LayoutDashboard, texto: 'Informe' },
    { a: '/maestro', icono: PackageSearch, texto: 'Maestro' },
    ...(esOperativo ? [
      { a: '/entradas', icono: ArrowDownToLine, texto: 'Entradas' },
      { a: '/salidas', icono: ArrowUpFromLine, texto: 'Salidas' },
      { a: '/articulos', icono: ScanBarcode, texto: 'Artículos' },
    ] : []),
    ...(esAdministrador ? [{ a: '/catalogos', icono: LibraryBig, texto: 'Catálogos' }] : []),
    { a: '/kardex', icono: Search, texto: 'Kardex' },
    ...(esAdministrador ? [{ a: '/usuarios', icono: Users, texto: 'Usuarios' }] : []),
  ];

  // Tailwind JIT necesita las clases literales (no puede construir
  // "grid-cols-" + n dinámicamente), por eso el mapa explícito en vez de
  // una plantilla de string.
  const COLS_MOVIL: Record<number, string> = {
    3: 'grid-cols-3', 4: 'grid-cols-4', 5: 'grid-cols-5', 6: 'grid-cols-6', 7: 'grid-cols-7', 8: 'grid-cols-8',
  };
  const colsMovil = COLS_MOVIL[nav.length] ?? 'grid-cols-7';

  return (
    <div className="min-h-screen">
      {/* ================= Sidebar (desktop) ================= */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 hidden md:flex flex-col bg-pizarra-800 text-pizarra-300 transition-[width] duration-200 print:hidden ${colapsado ? 'w-[68px]' : 'w-60'}`}
      >
        <div className="flex items-center gap-3 px-4 py-5">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-white p-1 ring-1 ring-white/10">
            <img src="/img/logo.png" alt="Comercializadora T&E S.A.S." className="h-full w-full object-contain" />
          </div>
          {!colapsado && (
            <div className="leading-tight">
              <p className="text-[15px] font-bold text-white tracking-wide">Comercializadora T&amp;E</p>
            </div>
          )}
        </div>
        <div className="costura-vertical absolute right-0 top-4 bottom-4 opacity-20" />

        <nav className="mt-2 flex-1 space-y-1 px-2.5">
          {nav.map(({ a, icono: Icono, texto }) => (
            <NavLink
              key={a}
              to={a}
              end={a === '/'}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-[10px] px-3 py-2.5 text-[14px] font-medium transition ${
                  isActive ? 'bg-indigo-600 text-white shadow-sastre' : 'hover:bg-white/5 hover:text-white'
                }`
              }
              title={texto}
            >
              <Icono size={19} className="shrink-0" />
              {!colapsado && texto}
            </NavLink>
          ))}
          {esOperativo && (
            <button
              onClick={() => setPrintAbierto(true)}
              className="flex w-full items-center gap-3 rounded-[10px] px-3 py-2.5 text-[14px] font-medium transition hover:bg-white/5 hover:text-white"
              title="Imprimir documentos"
            >
              <Printer size={19} className="shrink-0" />
              {!colapsado && 'Imprimir'}
            </button>
          )}
        </nav>

        <div className="border-t border-white/10 px-2.5 py-3 space-y-1">
          {!colapsado && (
            <div className="px-3 pb-1">
              <p className="truncate text-[13px] font-medium text-white">{nombre || 'Usuario'}</p>
              <p className="text-[11px] uppercase tracking-wider text-indigo-400 font-semibold">{etiquetaRol(rol)}</p>
            </div>
          )}
          <button onClick={salir} className="flex w-full items-center gap-3 rounded-[10px] px-3 py-2 text-[13.5px] hover:bg-white/5 hover:text-white transition" title="Cerrar sesión">
            <LogOut size={18} className="shrink-0" /> {!colapsado && 'Cerrar sesión'}
          </button>
          <button
            onClick={() => setColapsado((c) => !c)}
            className="flex w-full items-center gap-3 rounded-[10px] px-3 py-2 text-[13.5px] hover:bg-white/5 hover:text-white transition"
            title={colapsado ? 'Expandir' : 'Colapsar'}
          >
            {colapsado ? <PanelLeftOpen size={18} /> : <><PanelLeftClose size={18} /> Colapsar</>}
          </button>
        </div>
      </aside>

      {/* ================= Header móvil ================= */}
      <header className="sticky top-0 z-40 flex items-center justify-between bg-pizarra-800 px-4 pb-3 text-white md:hidden print:hidden [padding-top:max(0.75rem,env(safe-area-inset-top))]">
        <div className="flex items-center gap-2.5">
          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-white p-1 ring-1 ring-white/10">
            <img src="/img/logo.png" alt="Comercializadora T&E S.A.S." className="h-full w-full object-contain" />
          </div>
          <span className="truncate text-[15px] font-bold tracking-wide">Comercializadora T&amp;E</span>
        </div>
        <div className="flex items-center gap-1">
          {esOperativo && (
            <button onClick={() => setPrintAbierto(true)} className="rounded-lg p-2 hover:bg-white/10 transition" aria-label="Imprimir documentos">
              <Printer size={19} />
            </button>
          )}
          <button onClick={salir} className="rounded-lg p-2 hover:bg-white/10 transition" aria-label="Cerrar sesión">
            <LogOut size={19} />
          </button>
        </div>
      </header>

      {/* ================= Contenido ================= */}
      <main className={`px-4 pb-28 pt-6 md:pb-10 md:pt-8 md:pr-8 transition-[padding] duration-200 ${colapsado ? 'md:pl-[92px]' : 'md:pl-[264px]'}`}>
        <div className="mx-auto max-w-6xl">{children}</div>
      </main>

      {/* ================= Bottom Navigation (móvil, estilo app nativa) ================= */}
      <nav className={`fixed inset-x-0 bottom-0 z-40 grid ${colsMovil} border-t border-pizarra-200 bg-white/95 backdrop-blur pb-[env(safe-area-inset-bottom)] md:hidden print:hidden`}>
        {nav.map(({ a, icono: Icono, texto }) => (
          <NavLink
            key={a}
            to={a}
            end={a === '/'}
            className={({ isActive }) =>
              `flex flex-col items-center gap-0.5 py-2.5 text-[10.5px] font-semibold transition ${
                isActive ? 'text-indigo-600' : 'text-pizarra-400'
              }`
            }
          >
            {({ isActive }) => (
              <>
                <span className={`grid h-7 w-11 place-items-center rounded-full transition ${isActive ? 'bg-indigo-600/10' : ''}`}>
                  <Icono size={20} />
                </span>
                {texto}
              </>
            )}
          </NavLink>
        ))}
      </nav>

      <PrintModal abierto={printAbierto} onCerrar={() => setPrintAbierto(false)} />
    </div>
  );
}
