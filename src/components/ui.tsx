import { ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Scissors, Search } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useToast } from '../context/ToastContext';
import { Producto } from '../lib/types';
import { numero } from '../utils/format';
import { mensajeErrorBusqueda } from '../utils/busqueda';

/* ============================================================
   Modal de confirmación elegante (Eliminar, acciones críticas)
   ============================================================ */
export function ConfirmModal({
  abierto, titulo, mensaje, onConfirmar, onCancelar, textoConfirmar = 'Eliminar', deshabilitado = false,
}: {
  abierto: boolean;
  titulo: string;
  mensaje: string;
  onConfirmar: () => void;
  onCancelar: () => void;
  textoConfirmar?: string;
  deshabilitado?: boolean;
}) {
  useEffect(() => {
    if (!abierto) return;
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancelar(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [abierto, onCancelar]);

  if (!abierto) return null;
  return (
    <div className="fixed inset-0 z-[80] flex items-end md:items-center justify-center bg-pizarra-900/40 backdrop-blur-[2px] p-4 print:hidden" onClick={onCancelar}>
      <div className="modal-enter dt-card w-full max-w-sm p-6" role="alertdialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-borgona-50 text-borgona-600">
          <Scissors size={22} />
        </div>
        <h3 className="text-center text-[17px] font-bold text-pizarra-800">{titulo}</h3>
        <p className="mt-2 text-center text-[14px] leading-relaxed text-pizarra-500">{mensaje}</p>
        <div className="mt-6 grid grid-cols-2 gap-3">
          <button className="dt-btn dt-btn-ghost" onClick={onCancelar} disabled={deshabilitado} autoFocus>Cancelar</button>
          <button className="dt-btn dt-btn-danger" onClick={onConfirmar} disabled={deshabilitado}>{textoConfirmar}</button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   Buscador dinámico de productos con autocompletado
   ============================================================ */
export function BuscadorProducto({
  onSeleccion, autoFocus, inputRef, placeholder = 'Buscar por nombre o código…', soloActivos = true, disabled,
}: {
  onSeleccion: (p: Producto) => void;
  autoFocus?: boolean;
  inputRef?: React.RefObject<HTMLInputElement>;
  placeholder?: string;
  /** false permite encontrar artículos inactivos (ej. Kardex, para auditar historial). */
  soloActivos?: boolean;
  disabled?: boolean;
}) {
  const { toast } = useToast();
  const [q, setQ] = useState('');
  const [resultados, setResultados] = useState<Producto[]>([]);
  const [abierto, setAbierto] = useState(false);
  const [cursor, setCursor] = useState(-1);
  const [mensajeError, setMensajeError] = useState<string | null>(null);
  const localRef = useRef<HTMLInputElement>(null);
  const ref = inputRef ?? localRef;
  const timer = useRef<ReturnType<typeof setTimeout>>();
  // Cuenta cada búsqueda disparada; si una respuesta llega y ya no es la
  // más reciente (por ejemplo, la red reordenó dos respuestas), se
  // descarta. Sin esto, una búsqueda vieja podía pisar los resultados de
  // una más nueva y mostrar coincidencias que no corresponden al texto que
  // el usuario realmente escribió — riesgoso aquí porque este buscador se
  // usa para elegir el artículo de una línea de Entradas/Salidas/Kardex.
  const idBusqueda = useRef(0);

  useEffect(() => {
    clearTimeout(timer.current);
    if (q.trim().length < 2) { setResultados([]); setAbierto(false); return; }
    timer.current = setTimeout(async () => {
      const idActual = ++idBusqueda.current;
      // Búsqueda centralizada en el servidor (rpc_buscar_productos, ver
      // supabase/migration_013_busqueda_optimizada.sql): parte el término en
      // palabras y exige que cada una aparezca en ALGÚN campo visible del
      // artículo (nombre, código, género, color, talla) — no necesariamente
      // el mismo campo, así "chaqueta negro" encuentra nombre="CHAQUETA
      // ACOLCHADA ORION" con color="NEGRO". La RPC además ignora
      // mayúsculas/minúsculas Y tildes (antes "pantalon" no encontraba
      // "PANTALÓN"), algo que un filtro `ilike` armado en el cliente no
      // podía resolver sin duplicar esa lógica de normalización aquí.
      const { data, error } = await supabase.rpc('rpc_buscar_productos', {
        p_termino: q,
        p_solo_activos: soloActivos,
        p_limite: 8,
      });
      // Antes se ignoraba `error` por completo: si la consulta fallaba (RLS,
      // corte de red, etc.) el usuario solo veía "Sin coincidencias", como si
      // el artículo no existiera, sin ninguna pista de que en realidad la
      // búsqueda ni siquiera llegó a completarse.
      if (idActual !== idBusqueda.current) return;
      if (error) {
        // mensajeErrorBusqueda distingue "el servidor no tiene la función/
        // extensión de búsqueda configurada" (falta aplicar una migración)
        // de un problema real de red — antes ambos casos mostraban el mismo
        // "verifique su conexión", lo que llevaba a diagnosticar mal la
        // causa (ver supabase/migration_013_busqueda_optimizada.sql).
        const msg = mensajeErrorBusqueda(error);
        setResultados([]);
        setMensajeError(msg);
        setAbierto(true);
        toast('error', msg);
        return;
      }
      setMensajeError(null);
      setResultados((data as Producto[]) ?? []);
      setAbierto(true);
      setCursor(-1);
    }, 220);
    return () => clearTimeout(timer.current);
  }, [q, soloActivos, toast]);

  const elegir = (p: Producto) => {
    onSeleccion(p);
    setQ('');
    setAbierto(false);
  };

  return (
    <div className="relative">
      <Search size={16} className="pointer-events-none absolute left-4 top-1/2 z-10 -translate-y-1/2 text-pizarra-400" />
      <input
        ref={ref}
        value={q}
        autoFocus={autoFocus}
        disabled={disabled}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (!abierto || resultados.length === 0) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(c + 1, resultados.length - 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
          if (e.key === 'Enter' && cursor >= 0) { e.preventDefault(); elegir(resultados[cursor]); }
          if (e.key === 'Escape') setAbierto(false);
        }}
        onBlur={() => setTimeout(() => setAbierto(false), 160)}
        placeholder={placeholder}
        className="dt-input !pl-11"
        aria-label="Buscar producto"
      />
      {abierto && (
        <ul className="absolute z-30 mt-1.5 max-h-72 w-full overflow-auto rounded-xl border border-pizarra-200 bg-white shadow-sastre-lg">
          {mensajeError ? (
            <li className="px-4 py-3 text-[13px] font-medium leading-snug text-red-600">{mensajeError}</li>
          ) : resultados.length === 0 && (
            <li className="px-4 py-3 text-[14px] text-pizarra-400">Sin coincidencias</li>
          )}
          {resultados.map((p, i) => (
            <li key={p.id_producto}>
              <button
                type="button"
                onMouseDown={(e) => { e.preventDefault(); elegir(p); }}
                className={`flex w-full flex-col gap-0.5 px-4 py-2.5 text-left transition ${i === cursor ? 'bg-indigo-600/10' : 'hover:bg-pizarra-50'}`}
              >
                <span className="flex items-center gap-1.5 font-mono text-[12px] text-indigo-600">
                  {p.codigo_barra}
                  {!p.activo && (
                    <span className="rounded-full bg-pizarra-100 px-1.5 py-0.5 font-sans text-[10px] font-semibold text-pizarra-500">Inactivo</span>
                  )}
                </span>
                <span className="text-[14px] font-medium text-pizarra-800">
                  {[p.nombre, p.color, p.talla && `Talla ${p.talla}`].filter(Boolean).join(' · ')}
                </span>
                <span className="text-[12px] text-pizarra-400">Stock: {numero(p.stock_real)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ============================================================
   Tabla de datos con ordenamiento por cabecera y paginación
   (en móvil se transforma en tarjetas apilables)
   ============================================================ */
export interface Columna<T> {
  clave: keyof T & string;
  titulo: string;
  render?: (fila: T) => ReactNode;
  numerica?: boolean;
}

export function DataTable<T extends Record<string, unknown>>({
  columnas, filas, porPagina = 10, vacio = 'Sin registros', idDeFila, resaltarId,
}: {
  columnas: Columna<T>[];
  filas: T[];
  porPagina?: number;
  vacio?: string;
  /** Extrae un identificador único de cada fila (requerido para usar `resaltarId`). */
  idDeFila?: (fila: T) => string;
  /** Si el id de una fila visible coincide, se resalta brevemente (ej. registro recién creado). */
  resaltarId?: string | null;
}) {
  const [orden, setOrden] = useState<{ clave: string; asc: boolean } | null>(null);
  const [pagina, setPagina] = useState(1);

  const ordenadas = useMemo(() => {
    if (!orden) return filas;
    const copia = [...filas];
    copia.sort((a, b) => {
      const va = a[orden.clave]; const vb = b[orden.clave];
      if (typeof va === 'number' && typeof vb === 'number') return orden.asc ? va - vb : vb - va;
      return orden.asc
        ? String(va ?? '').localeCompare(String(vb ?? ''), 'es')
        : String(vb ?? '').localeCompare(String(va ?? ''), 'es');
    });
    return copia;
  }, [filas, orden]);

  const totalPaginas = Math.max(1, Math.ceil(ordenadas.length / porPagina));
  const pagSegura = Math.min(pagina, totalPaginas);
  const visibles = ordenadas.slice((pagSegura - 1) * porPagina, pagSegura * porPagina);

  const clickOrden = (clave: string) =>
    setOrden((o) => (o?.clave === clave ? { clave, asc: !o.asc } : { clave, asc: true }));

  // Al aparecer un id a resaltar (ej. registro recién creado), vuelve a la
  // página 1 para que quede a la vista sin que el usuario tenga que buscarlo.
  useEffect(() => {
    if (resaltarId) setPagina(1);
  }, [resaltarId]);

  // Si la cantidad de filas se reduce (ej. se elimina un registro) y la
  // página actual queda fuera de rango, la corrige. Sin esto, el número de
  // página quedaba "atascado" en un valor viejo que podía volver a
  // manifestarse de forma inconsistente si la lista crecía de nuevo.
  useEffect(() => {
    setPagina((p) => (p > totalPaginas ? totalPaginas : p));
  }, [totalPaginas]);

  return (
    <div>
      {/* Desktop: tabla */}
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full text-[14px]">
          <thead>
            <tr className="border-b border-pizarra-200 text-left">
              {columnas.map((c) => (
                <th key={c.clave} className={`py-2.5 px-3 font-semibold text-pizarra-500 text-[12.5px] uppercase tracking-wider ${c.numerica ? 'text-right' : ''}`}>
                  <button className="inline-flex items-center gap-1 hover:text-pizarra-800 transition" onClick={() => clickOrden(c.clave)}>
                    {c.titulo}
                    {orden?.clave === c.clave && (orden.asc ? <ChevronUp size={13} /> : <ChevronDown size={13} />)}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibles.length === 0 && (
              <tr><td colSpan={columnas.length} className="py-10 text-center text-pizarra-400">{vacio}</td></tr>
            )}
            {visibles.map((f, i) => {
              const esNueva = !!resaltarId && idDeFila?.(f) === resaltarId;
              return (
                <tr key={i} className={`border-b border-pizarra-100 transition ${esNueva ? 'bg-indigo-600/[0.06] hover:bg-indigo-600/10' : 'hover:bg-pizarra-50/70'}`}>
                  {columnas.map((c) => (
                    <td key={c.clave} className={`py-2.5 px-3 ${c.numerica ? 'text-right font-mono tabular-nums' : ''}`}>
                      {c.render ? c.render(f) : String(f[c.clave] ?? '—')}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Móvil: tarjetas informativas */}
      <div className="md:hidden space-y-2.5">
        {visibles.length === 0 && <p className="py-8 text-center text-pizarra-400 text-[14px]">{vacio}</p>}
        {visibles.map((f, i) => (
          <div key={i} className={`dt-card p-4 transition ${resaltarId && idDeFila?.(f) === resaltarId ? 'border-indigo-600/40 bg-indigo-600/[0.04] ring-1 ring-indigo-600/20' : ''}`}>
            {columnas.map((c) => (
              <div key={c.clave} className="flex items-start justify-between gap-3 py-1">
                <span className="text-[12px] font-semibold uppercase tracking-wide text-pizarra-400">{c.titulo}</span>
                <span className={`text-[13.5px] text-right ${c.numerica ? 'font-mono tabular-nums' : ''}`}>
                  {c.render ? c.render(f) : String(f[c.clave] ?? '—')}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>

      {totalPaginas > 1 && (
        <div className="mt-4 flex items-center justify-between text-[13px] text-pizarra-500">
          <span>{ordenadas.length} registros</span>
          <div className="flex items-center gap-2">
            <button className="dt-btn dt-btn-ghost !px-2.5 !py-1.5" disabled={pagSegura <= 1} onClick={() => setPagina(pagSegura - 1)} aria-label="Página anterior">
              <ChevronLeft size={16} />
            </button>
            <span className="font-medium">{pagSegura} / {totalPaginas}</span>
            <button className="dt-btn dt-btn-ghost !px-2.5 !py-1.5" disabled={pagSegura >= totalPaginas} onClick={() => setPagina(pagSegura + 1)} aria-label="Página siguiente">
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ============================================================
   Tarjeta KPI
   ============================================================ */
export function KpiCard({ titulo, valor, sufijo, acento, className = '' }: {
  titulo: string;
  valor: string;
  sufijo?: string;
  acento?: boolean;
  className?: string;
}) {
  return (
    // min-w-0 es necesario porque esta tarjeta vive dentro de un grid: sin
    // eso, un valor largo (ej. montos en soles con miles) no se encoge y
    // se desborda fuera del marco en vez de ajustarse o partir línea.
    <div className={`dt-card min-w-0 p-4 ${acento ? 'border-indigo-600/30 bg-indigo-600/[0.03]' : ''} ${className}`}>
      <p className="truncate text-[12px] font-semibold uppercase tracking-wider text-pizarra-400">{titulo}</p>
      <p className={`mt-1.5 break-words text-[18px] font-bold tabular-nums leading-tight sm:text-[22px] ${acento ? 'text-indigo-600' : 'text-pizarra-800'}`}>
        {valor}{sufijo && <span className="ml-1 text-[13px] font-medium text-pizarra-400">{sufijo}</span>}
      </p>
    </div>
  );
}

/* Encabezado de página */
export function PageHeader({ titulo, subtitulo, extra }: { titulo: string; subtitulo?: string; extra?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
      <div>
        <h1 className="text-[24px] md:text-[28px] font-extrabold tracking-tight text-pizarra-800">{titulo}</h1>
        {subtitulo && <p className="mt-1 text-[14px] text-pizarra-500">{subtitulo}</p>}
        <div className="costura mt-3 w-24" />
      </div>
      {extra}
    </div>
  );
}
