import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, Eraser, Printer, Save, Trash2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { BuscadorProducto, PageHeader } from '../components/ui';
import DocumentoImpreso from '../components/DocumentoImpreso';
import { DocumentoMovimiento, LineaMovimiento, Producto, Proveedor, TIPOS_ENTRADA } from '../lib/types';
import { limitesFechaMovimiento, moneda, numero } from '../utils/format';

const claveLocal = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export default function Entradas() {
  const { toast } = useToast();
  const { esOperativo } = useAuth();
  const buscadorRef = useRef<HTMLInputElement>(null);

  const [proveedores, setProveedores] = useState<Proveedor[]>([]);
  const [proveedor, setProveedor] = useState<Proveedor | null>(null);
  const [tipoMov, setTipoMov] = useState('1000');
  // Vacía a propósito: si arrancara con hoyISO(), es muy fácil guardar sin
  // darse cuenta con la fecha de hoy cuando en realidad se quería digitar
  // un movimiento de otro día — obliga a elegir la fecha siempre a mano.
  const [fecha, setFecha] = useState('');
  const [nroFactura, setNroFactura] = useState('');
  const [nroOrden, setNroOrden] = useState('');
  const [concepto, setConcepto] = useState('');
  const [lineas, setLineas] = useState<LineaMovimiento[]>([]);
  const [guardando, setGuardando] = useState(false);
  const [documentoGuardado, setDocumentoGuardado] = useState<DocumentoMovimiento | null>(null);

  const limites = useMemo(limitesFechaMovimiento, []);

  useEffect(() => {
    (async () => {
      try {
        const { data, error } = await supabase.from('terceros').select('*').order('razon_social');
        if (error) { toast('error', 'No se pudo cargar la lista de proveedores'); return; }
        setProveedores((data as Proveedor[]) ?? []);
      } catch {
        toast('error', 'Error de red al cargar proveedores. Verifique su conexión.');
      }
    })();
  }, [toast]);

  const agregarLinea = (p: Producto) => {
    setLineas((ls) => [...ls, {
      clave: claveLocal(), producto: p, cantidad: '',
      valorUnitario: p.costo_promedio_ponderado ? String(p.costo_promedio_ponderado) : '',
    }]);
  };
  const quitarLinea = (clave: string) => setLineas((ls) => ls.filter((l) => l.clave !== clave));
  const actualizarLinea = (clave: string, campo: 'cantidad' | 'valorUnitario', valor: string) =>
    setLineas((ls) => ls.map((l) => (l.clave === clave ? { ...l, [campo]: valor } : l)));

  const total = useMemo(
    () => lineas.reduce((s, l) => s + (parseFloat(l.cantidad) || 0) * (parseFloat(l.valorUnitario) || 0), 0),
    [lineas]
  );

  const limpiar = () => {
    setProveedor(null); setTipoMov('1000'); setFecha('');
    setNroFactura(''); setNroOrden(''); setConcepto(''); setLineas([]);
    buscadorRef.current?.focus();
  };

  // Distinto del reseteo automático post-guardado: el usuario pulsa esto
  // explícitamente para empezar un documento nuevo, así que además debe
  // ocultar el aviso "guardada con éxito · Documento N" del envío anterior
  // (si no, ese banner y su botón de imprimir quedan visibles mientras se
  // llena una entrada distinta, arriesgando que se imprima el documento
  // equivocado).
  const limpiarManual = () => {
    setDocumentoGuardado(null);
    limpiar();
  };

  const guardar = async (e: FormEvent) => {
    e.preventDefault();
    setDocumentoGuardado(null);
    if (!fecha) { toast('aviso', 'Seleccione la fecha del movimiento'); return; }
    if (!proveedor) { toast('aviso', 'Seleccione el proveedor'); return; }
    if (lineas.length === 0) { toast('aviso', 'Agregue al menos un artículo a la entrada'); return; }
    for (const l of lineas) {
      const c = parseFloat(l.cantidad);
      const v = parseFloat(l.valorUnitario);
      if (!c || c <= 0) { toast('error', `Cantidad inválida en "${l.producto.nombre}"`); return; }
      if (isNaN(v) || v < 0) { toast('error', `Valor unitario inválido en "${l.producto.nombre}"`); return; }
    }

    setGuardando(true);
    try {
      const { data, error } = await supabase.rpc('rpc_registrar_entrada_lote', {
        p_fecha: fecha,
        p_tipo_movimiento: tipoMov,
        p_proveedor_id: proveedor.id_proveedor,
        p_items: lineas.map((l) => ({
          producto_id: l.producto.id_producto,
          cantidad: parseFloat(l.cantidad),
          valor_unitario: parseFloat(l.valorUnitario),
        })),
        p_nro_factura: nroFactura || null,
        p_nro_orden: nroOrden || null,
        p_concepto: concepto || null,
      });
      if (error) {
        toast('error', error.message.replace(/^.*?:/, '').trim() || 'No se pudo registrar la entrada');
        return;
      }
      toast('exito', `Entrada guardada con éxito · Documento ${data.documento}`);
      try {
        const { data: doc } = await supabase.rpc('rpc_obtener_documento', { p_tipo: 'ENTRADA_ALMACEN', p_numero: data.documento });
        setDocumentoGuardado(doc as DocumentoMovimiento);
      } catch {
        // La entrada ya se guardó correctamente; solo falló traer el documento para imprimir de inmediato.
        toast('aviso', 'La entrada se guardó, pero no se pudo cargar la vista de impresión. Búsquela desde Imprimir.');
      }
      limpiar();
    } catch {
      toast('error', 'Error de red al registrar la entrada. Verifique su conexión e intente nuevamente.');
    } finally {
      setGuardando(false);
    }
  };

  return (
    <div>
      <PageHeader
        titulo="Entradas de almacén"
        subtitulo="Documento multilínea · el N° de documento se asigna automáticamente al guardar"
      />

      <form onSubmit={guardar} className="dt-card p-5 md:p-7 print:hidden">
        <div className="grid gap-5 md:grid-cols-2">
          <div>
            <label className="dt-label" htmlFor="tipo-mov">Tipo de movimiento</label>
            <select id="tipo-mov" className="dt-input" disabled={guardando} value={tipoMov} onChange={(e) => setTipoMov(e.target.value)}>
              {TIPOS_ENTRADA.map((t) => (
                <option key={t.codigo} value={t.codigo}>{t.codigo} — {t.nombre}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="dt-label" htmlFor="fecha">Fecha del movimiento</label>
            <input
              id="fecha" type="date" className="dt-input"
              min={limites.min} max={limites.max}
              value={fecha}
              disabled={guardando}
              onChange={(e) => setFecha(e.target.value)}
              required
            />
          </div>

          <div className="md:col-span-2">
            <label className="dt-label" htmlFor="proveedor">Proveedor</label>
            <select
              id="proveedor" className="dt-input"
              value={proveedor?.id_proveedor ?? ''}
              disabled={guardando}
              onChange={(e) => setProveedor(proveedores.find((p) => p.id_proveedor === e.target.value) ?? null)}
              required
            >
              <option value="" disabled>Seleccione un proveedor…</option>
              {proveedores.map((p) => (
                <option key={p.id_proveedor} value={p.id_proveedor}>{p.razon_social}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="dt-label" htmlFor="factura">N° Factura</label>
            <input id="factura" className="dt-input font-mono" value={nroFactura} disabled={guardando} onChange={(e) => setNroFactura(e.target.value)} placeholder="F001-000123" />
          </div>
          <div>
            <label className="dt-label" htmlFor="orden">N° Orden Compra</label>
            <input id="orden" className="dt-input font-mono" value={nroOrden} disabled={guardando} onChange={(e) => setNroOrden(e.target.value)} placeholder="OC-2026-045" />
          </div>

          <div className="md:col-span-2">
            <label className="dt-label" htmlFor="concepto">Concepto</label>
            <input id="concepto" className="dt-input" value={concepto} disabled={guardando} onChange={(e) => setConcepto(e.target.value)} placeholder="Reposición de temporada…" />
          </div>
        </div>

        <div className="costura my-6" />

        <label className="dt-label">Agregar artículo a la entrada</label>
        <BuscadorProducto onSeleccion={agregarLinea} inputRef={buscadorRef} autoFocus disabled={guardando} placeholder="Busque un artículo y presione Enter para agregarlo…" />

        <div className="mt-4 space-y-2.5">
          {lineas.length === 0 && (
            <div className="grid place-items-center rounded-xl border border-dashed border-pizarra-300 py-10 text-center">
              <p className="text-[13.5px] text-pizarra-400">Aún no agregó artículos a esta entrada.</p>
            </div>
          )}
          {lineas.map((l) => (
            <div key={l.clave} className="grid grid-cols-2 items-center gap-3 rounded-xl border border-pizarra-200 px-4 py-3 sm:grid-cols-[1fr_110px_140px_auto]">
              <div className="col-span-2 min-w-0 sm:col-span-1">
                <p className="truncate text-[14px] font-semibold text-pizarra-800">{l.producto.nombre}</p>
                <p className="truncate text-[12px] text-pizarra-500">{[l.producto.color, l.producto.talla].filter(Boolean).join(' · ') || l.producto.codigo_barra}</p>
              </div>
              <input
                type="number" min="0.01" step="0.01" inputMode="decimal" placeholder="Cantidad"
                value={l.cantidad} disabled={guardando} onChange={(e) => actualizarLinea(l.clave, 'cantidad', e.target.value)}
                className="dt-input text-right font-mono"
              />
              <input
                type="number" min="0" step="0.01" inputMode="decimal" placeholder="Valor unit."
                value={l.valorUnitario} disabled={guardando} onChange={(e) => actualizarLinea(l.clave, 'valorUnitario', e.target.value)}
                className="dt-input text-right font-mono"
              />
              <button
                type="button"
                className="justify-self-end rounded-lg p-1.5 text-pizarra-300 transition hover:bg-borgona-50 hover:text-borgona-600 disabled:opacity-30"
                onClick={() => quitarLinea(l.clave)}
                disabled={guardando}
                aria-label={`Quitar ${l.producto.nombre}`}
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </div>

        <div className="costura my-6" />
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-[12px] font-semibold uppercase tracking-wider text-pizarra-400">Total de la entrada · {lineas.length} línea(s)</p>
            <p className="text-[28px] font-extrabold tabular-nums text-pizarra-800">{moneda(total)}</p>
          </div>
          <div className="flex gap-3">
            <button type="button" className="dt-btn dt-btn-ghost" onClick={limpiarManual} disabled={guardando}>
              <Eraser size={17} /> Limpiar
            </button>
            <button type="submit" className="dt-btn dt-btn-primary" disabled={guardando || !esOperativo}>
              {guardando ? <Save size={17} className="animate-pulse" /> : <ArrowDownToLine size={17} />}
              {guardando ? 'Guardando…' : 'Guardar entrada'}
            </button>
          </div>
        </div>
        {!esOperativo && (
          <p className="mt-4 rounded-[10px] bg-amber-50 px-4 py-2.5 text-[13px] text-amber-700">
            Su rol es <strong>Consulta</strong>: puede visualizar pero no registrar movimientos.
          </p>
        )}
      </form>

      {documentoGuardado && (
        <div className="dt-card mt-6 flex flex-col items-start gap-3 border-emerald-200 bg-emerald-50 p-5 sm:flex-row sm:items-center sm:justify-between print:hidden">
          <div>
            <p className="text-[13px] font-semibold text-emerald-700">Entrada guardada con éxito</p>
            <p className="text-[22px] font-extrabold text-emerald-800">Documento {documentoGuardado.documento_numero}</p>
          </div>
          <button type="button" className="dt-btn dt-btn-primary" onClick={() => window.print()}>
            <Printer size={16} /> Imprimir
          </button>
        </div>
      )}

      {documentoGuardado && <DocumentoImpreso doc={documentoGuardado} />}
    </div>
  );
}
