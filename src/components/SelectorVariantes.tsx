import { useEffect, useRef, useState } from 'react';
import { Layers, Plus, Search, X } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useToast } from '../context/ToastContext';
import { Producto } from '../lib/types';
import { numero } from '../utils/format';

export interface ItemLoteVariantes {
  producto: Producto;
  cantidad: string;
  valorUnitario?: string;
}

/**
 * Alta múltiple de variantes (tallas) de un mismo artículo en una sola
 * acción: el usuario busca UNA vez (ej. "camisa azul"), el componente trae
 * TODAS las tallas activas de esa combinación nombre+género+color, y el
 * usuario digita cantidad (y valor unitario, en Entradas) por talla. Un solo
 * clic en "Agregar" entrega todas las líneas juntas — antes había que repetir
 * la búsqueda con BuscadorProducto una vez por cada talla.
 *
 * El documento sigue siendo el mismo de siempre (rpc_registrar_entrada_lote /
 * rpc_registrar_salida_lote ya aceptan N líneas de distintos productos bajo
 * un solo documento_numero): este componente solo acelera cómo se arma esa
 * lista en el formulario, no cambia el modelo de datos.
 */
export default function SelectorVariantes({
  onAgregarLote,
  disabled,
  mostrarValorUnitario = false,
  idsExistentes = [],
}: {
  onAgregarLote: (items: ItemLoteVariantes[]) => void;
  disabled?: boolean;
  /** true en Entradas (el valor unitario lo digita el usuario); false en Salidas (se calcula por CPP). */
  mostrarValorUnitario?: boolean;
  /** ids de producto que ya están en las líneas del documento en curso — se marcan y se excluyen al agregar. */
  idsExistentes?: string[];
}) {
  const { toast } = useToast();
  const [abierto, setAbierto] = useState(false);
  const [q, setQ] = useState('');
  const [resultados, setResultados] = useState<Producto[]>([]);
  const [buscando, setBuscando] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const idBusqueda = useRef(0);

  const [grupo, setGrupo] = useState<Producto | null>(null);
  const [variantes, setVariantes] = useState<Producto[]>([]);
  const [cargandoVariantes, setCargandoVariantes] = useState(false);
  const [cantidades, setCantidades] = useState<Record<string, string>>({});
  const [valores, setValores] = useState<Record<string, string>>({});

  // Misma búsqueda por palabras/sin tildes que BuscadorProducto (ver
  // rpc_buscar_productos), solo que aquí basta con encontrar UN
  // representante del grupo nombre+género+color — las demás tallas se traen
  // aparte al seleccionarlo.
  useEffect(() => {
    clearTimeout(timer.current);
    if (q.trim().length < 2) { setResultados([]); return; }
    timer.current = setTimeout(async () => {
      const idActual = ++idBusqueda.current;
      setBuscando(true);
      const { data, error } = await supabase.rpc('rpc_buscar_productos', {
        p_termino: q,
        p_solo_activos: true,
        p_limite: 8,
      });
      if (idActual !== idBusqueda.current) return;
      setBuscando(false);
      if (error) { setResultados([]); return; }
      setResultados((data as Producto[]) ?? []);
    }, 220);
    return () => clearTimeout(timer.current);
  }, [q]);

  const elegirGrupo = async (p: Producto) => {
    setQ('');
    setResultados([]);
    setGrupo(p);
    setCantidades({});
    setValores({});
    setCargandoVariantes(true);
    try {
      let consulta = supabase.from('productos').select('*')
        .eq('id_familia', p.id_familia)
        .eq('nombre', p.nombre)
        .eq('activo', true);
      consulta = p.genero ? consulta.eq('genero', p.genero) : consulta.is('genero', null);
      consulta = p.color ? consulta.eq('color', p.color) : consulta.is('color', null);
      const { data, error } = await consulta.order('talla', { ascending: true, nullsFirst: true });
      if (error) { toast('error', 'No se pudieron cargar las tallas de este artículo'); setVariantes([]); return; }
      const lista = (data as Producto[]) ?? [];
      setVariantes(lista);
      if (mostrarValorUnitario) {
        const iniciales: Record<string, string> = {};
        lista.forEach((v) => {
          if (v.costo_promedio_ponderado) iniciales[v.id_producto] = String(v.costo_promedio_ponderado);
        });
        setValores(iniciales);
      }
    } catch {
      toast('error', 'Error de red al cargar las tallas. Verifique su conexión.');
      setVariantes([]);
    } finally {
      setCargandoVariantes(false);
    }
  };

  const cerrarPanel = () => {
    setAbierto(false);
    setQ(''); setResultados([]);
    setGrupo(null); setVariantes([]);
    setCantidades({}); setValores({});
  };

  const agregarTodas = () => {
    const filas = variantes.filter((v) => !idsExistentes.includes(v.id_producto) && (cantidades[v.id_producto] ?? '').trim() !== '');
    if (filas.length === 0) {
      toast('aviso', 'Digite la cantidad de al menos una talla');
      return;
    }
    for (const v of filas) {
      const c = parseFloat(cantidades[v.id_producto]);
      if (!c || c <= 0) { toast('error', `Cantidad inválida en talla "${v.talla ?? v.codigo_barra}"`); return; }
      if (mostrarValorUnitario) {
        const val = parseFloat(valores[v.id_producto] ?? '');
        if (isNaN(val) || val < 0) { toast('error', `Valor unitario inválido en talla "${v.talla ?? v.codigo_barra}"`); return; }
      }
    }
    const items: ItemLoteVariantes[] = filas.map((v) => ({
      producto: v,
      cantidad: cantidades[v.id_producto],
      valorUnitario: mostrarValorUnitario ? valores[v.id_producto] : undefined,
    }));
    onAgregarLote(items);
    toast('exito', `${items.length} talla${items.length === 1 ? '' : 's'} agregada${items.length === 1 ? '' : 's'} a la lista`);
    cerrarPanel();
  };

  if (!abierto) {
    return (
      <button
        type="button"
        className="dt-btn dt-btn-ghost"
        onClick={() => setAbierto(true)}
        disabled={disabled}
      >
        <Layers size={16} /> Agregar varias tallas de un artículo
      </button>
    );
  }

  return (
    <div className="rounded-xl border border-indigo-600/25 bg-indigo-600/[0.03] p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="flex items-center gap-1.5 text-[13.5px] font-semibold text-pizarra-700">
          <Layers size={16} className="text-indigo-600" /> Agregar varias tallas en un solo paso
        </p>
        <button type="button" className="rounded-lg p-1.5 text-pizarra-400 hover:bg-pizarra-100 hover:text-pizarra-700 transition" onClick={cerrarPanel} aria-label="Cerrar">
          <X size={16} />
        </button>
      </div>

      {!grupo ? (
        <div className="relative mt-3">
          <Search size={16} className="pointer-events-none absolute left-4 top-1/2 z-10 -translate-y-1/2 text-pizarra-400" />
          <input
            value={q}
            autoFocus
            disabled={disabled}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Busque el artículo base (ej. camisa azul)…"
            className="dt-input !pl-11"
            aria-label="Buscar artículo para agregar varias tallas"
          />
          {q.trim().length >= 2 && (
            <ul className="relative z-30 mt-1.5 max-h-64 overflow-auto rounded-xl border border-pizarra-200 bg-white shadow-sastre-lg">
              {buscando && <li className="px-4 py-3 text-[13px] text-pizarra-400">Buscando…</li>}
              {!buscando && resultados.length === 0 && (
                <li className="px-4 py-3 text-[13px] text-pizarra-400">Sin coincidencias</li>
              )}
              {!buscando && resultados.map((p) => (
                <li key={p.id_producto}>
                  <button
                    type="button"
                    onClick={() => elegirGrupo(p)}
                    className="flex w-full flex-col gap-0.5 px-4 py-2.5 text-left transition hover:bg-pizarra-50"
                  >
                    <span className="font-mono text-[12px] text-indigo-600">{p.codigo_barra}</span>
                    <span className="text-[14px] font-medium text-pizarra-800">
                      {[p.nombre, p.genero, p.color].filter(Boolean).join(' · ')}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="mt-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[14px] font-semibold text-pizarra-800">
              {[grupo.nombre, grupo.genero, grupo.color].filter(Boolean).join(' · ')}
            </p>
            <button type="button" className="text-[12.5px] font-semibold text-indigo-600 hover:underline" onClick={() => { setGrupo(null); setVariantes([]); }}>
              Cambiar artículo
            </button>
          </div>

          {cargandoVariantes ? (
            <p className="mt-4 py-6 text-center text-[13.5px] text-pizarra-400">Cargando tallas…</p>
          ) : variantes.length === 0 ? (
            <p className="mt-4 py-6 text-center text-[13.5px] text-pizarra-400">No se encontraron tallas activas para este artículo.</p>
          ) : (
            <div className="mt-3 space-y-2">
              {variantes.map((v) => {
                const yaAgregado = idsExistentes.includes(v.id_producto);
                return (
                  <div
                    key={v.id_producto}
                    className={`grid grid-cols-[1fr_90px] items-center gap-3 rounded-lg border px-3 py-2 sm:grid-cols-[70px_1fr_110px_130px] ${yaAgregado ? 'border-pizarra-100 bg-pizarra-50 opacity-60' : 'border-pizarra-200'}`}
                  >
                    <span className="font-mono text-[13px] font-semibold text-pizarra-700">{v.talla ?? '—'}</span>
                    <span className="hidden text-[12px] text-pizarra-400 sm:block">
                      Stock: {numero(v.stock_real)}{yaAgregado ? ' · Ya agregado' : ''}
                    </span>
                    <input
                      type="number" min="0.01" step="0.01" inputMode="decimal" placeholder="Cantidad"
                      value={cantidades[v.id_producto] ?? ''}
                      disabled={disabled || yaAgregado}
                      onChange={(e) => setCantidades((c) => ({ ...c, [v.id_producto]: e.target.value }))}
                      className="dt-input !py-1.5 text-right font-mono text-[13px]"
                      aria-label={`Cantidad talla ${v.talla ?? v.codigo_barra}`}
                    />
                    {mostrarValorUnitario && (
                      <input
                        type="number" min="0" step="0.01" inputMode="decimal" placeholder="Valor unit."
                        value={valores[v.id_producto] ?? ''}
                        disabled={disabled || yaAgregado}
                        onChange={(e) => setValores((c) => ({ ...c, [v.id_producto]: e.target.value }))}
                        className="dt-input !py-1.5 text-right font-mono text-[13px]"
                        aria-label={`Valor unitario talla ${v.talla ?? v.codigo_barra}`}
                      />
                    )}
                  </div>
                );
              })}

              <div className="flex justify-end pt-1">
                <button type="button" className="dt-btn dt-btn-primary" onClick={agregarTodas} disabled={disabled}>
                  <Plus size={16} /> Agregar tallas a la lista
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
