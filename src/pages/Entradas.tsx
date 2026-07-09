import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, Eraser, Save } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { BuscadorProducto, PageHeader } from '../components/ui';
import ImportadorEntradas from '../components/ImportadorEntradas';
import { Producto, Proveedor, TIPOS_ENTRADA } from '../lib/types';
import { hoyISO, limitesMesActual, moneda, numero } from '../utils/format';
import { borrarBorrador, CLAVE_BORRADOR_ENTRADA, guardarBorrador, leerBorrador } from '../utils/borrador';

interface BorradorEntrada {
  producto: Producto | null;
  proveedorId: string;
  tipoMov: string;
  fecha: string;
  cantidad: string;
  valor: string;
  nroFactura: string;
  nroOrden: string;
  concepto: string;
}

export default function Entradas() {
  const { toast } = useToast();
  const { esOperativo, session } = useAuth();
  const uid = session?.user.id ?? '';
  const buscadorRef = useRef<HTMLInputElement>(null);
  const restaurado = useRef(false);

  const [proveedores, setProveedores] = useState<Proveedor[]>([]);
  const [producto, setProducto] = useState<Producto | null>(null);
  const [proveedor, setProveedor] = useState<Proveedor | null>(null);
  const [tipoMov, setTipoMov] = useState('1000');
  const [fecha, setFecha] = useState(hoyISO());
  const [cantidad, setCantidad] = useState('');
  const [valor, setValor] = useState('');
  const [nroFactura, setNroFactura] = useState('');
  const [nroOrden, setNroOrden] = useState('');
  const [concepto, setConcepto] = useState('');
  const [guardando, setGuardando] = useState(false);

  const limites = useMemo(limitesMesActual, []);

  // Total calculado reactivamente (onChange, sin refrescar pantalla)
  const total = useMemo(() => {
    const c = parseFloat(cantidad) || 0;
    const v = parseFloat(valor) || 0;
    return c * v;
  }, [cantidad, valor]);

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

  // Restaura el borrador (si existe y pertenece al usuario actual) una sola
  // vez que los proveedores ya cargaron, para poder resolver el id guardado.
  useEffect(() => {
    if (!uid || restaurado.current || proveedores.length === 0) return;
    restaurado.current = true;
    const b = leerBorrador<BorradorEntrada>(CLAVE_BORRADOR_ENTRADA, uid);
    if (!b) return;
    setProducto(b.producto);
    setProveedor(proveedores.find((p) => p.id_proveedor === b.proveedorId) ?? null);
    setTipoMov(b.tipoMov); setFecha(b.fecha);
    setCantidad(b.cantidad); setValor(b.valor);
    setNroFactura(b.nroFactura); setNroOrden(b.nroOrden); setConcepto(b.concepto);
    toast('aviso', 'Se restauró un formulario de entrada sin guardar');
  }, [uid, proveedores, toast]);

  // Persiste el formulario en cada cambio para sobrevivir a un F5 accidental.
  // Solo si hay un producto elegido: guardar el formulario vacío por defecto
  // (como queda al entrar a la página) hacía que CADA visita "restaurara" un
  // borrador sin contenido real y mostrara el aviso de forma innecesaria.
  useEffect(() => {
    if (!uid) return;
    if (!producto) { borrarBorrador(CLAVE_BORRADOR_ENTRADA); return; }
    const b: BorradorEntrada = {
      producto, proveedorId: proveedor?.id_proveedor ?? '', tipoMov, fecha,
      cantidad, valor, nroFactura, nroOrden, concepto,
    };
    guardarBorrador(CLAVE_BORRADOR_ENTRADA, uid, b);
  }, [uid, producto, proveedor, tipoMov, fecha, cantidad, valor, nroFactura, nroOrden, concepto]);

  const limpiar = () => {
    setProducto(null); setProveedor(null); setTipoMov('1000');
    setFecha(hoyISO()); setCantidad(''); setValor('');
    setNroFactura(''); setNroOrden(''); setConcepto('');
    borrarBorrador(CLAVE_BORRADOR_ENTRADA);
    buscadorRef.current?.focus();                 // devolver el foco al primer input operativo
  };

  const guardar = async (e: FormEvent) => {
    e.preventDefault();
    if (!producto) { toast('aviso', 'Seleccione un producto con el buscador'); return; }
    if (!proveedor) { toast('aviso', 'Seleccione el proveedor'); return; }
    const c = parseFloat(cantidad);
    const v = parseFloat(valor);
    if (!c || c <= 0) { toast('error', 'La cantidad debe ser mayor a 0'); return; }
    if (isNaN(v) || v < 0) { toast('error', 'Ingrese un valor unitario válido'); return; }

    setGuardando(true);
    try {
      const { data, error } = await supabase.rpc('rpc_registrar_entrada', {
        p_producto_id: producto.id_producto,
        p_tipo_movimiento: tipoMov,
        p_cantidad: c,
        p_valor_unitario: v,
        p_proveedor_id: proveedor.id_proveedor,
        p_nro_factura: nroFactura || null,
        p_nro_orden: nroOrden || null,
        p_concepto: concepto || null,
        p_fecha: fecha,
      });
      if (error) { toast('error', error.message.replace(/^.*?:/, '').trim() || 'No se pudo registrar la entrada'); return; }
      toast('exito', `Entrada guardada con éxito · ${data.consecutivo}`);
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
        subtitulo="Abastecimiento · el consecutivo ENT se genera automáticamente al guardar"
        extra={<ImportadorEntradas deshabilitado={!esOperativo} />}
      />

      <form onSubmit={guardar} className="dt-card p-5 md:p-7">
        <div className="grid gap-5 md:grid-cols-2">
          {/* Paso 1: Producto */}
          <div className="md:col-span-2">
            <label className="dt-label">1 · Producto</label>
            <BuscadorProducto onSeleccion={setProducto} inputRef={buscadorRef} autoFocus />
            {producto && (
              <div className="mt-3 rounded-[10px] border border-indigo-600/25 bg-indigo-600/[0.04] px-4 py-3">
                <p className="font-mono text-[12.5px] text-indigo-600">{producto.codigo_barra}</p>
                <p className="text-[14px] font-semibold text-pizarra-800">
                  {producto.nombre} · {producto.genero} · {producto.color} · Talla {producto.talla}
                </p>
                <p className="text-[12.5px] text-pizarra-500">
                  Stock actual: <strong>{numero(producto.stock_real)}</strong> · CPP: {moneda(producto.costo_promedio_ponderado)}
                </p>
              </div>
            )}
          </div>

          <div>
            <label className="dt-label" htmlFor="tipo-mov">2 · Tipo de movimiento</label>
            <select id="tipo-mov" className="dt-input" value={tipoMov} onChange={(e) => setTipoMov(e.target.value)}>
              {TIPOS_ENTRADA.map((t) => (
                <option key={t.codigo} value={t.codigo}>{t.codigo} — {t.nombre}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="dt-label" htmlFor="fecha">3 · Fecha (mes actual)</label>
            <input
              id="fecha" type="date" className="dt-input"
              min={limites.min} max={limites.max}
              value={fecha}
              onChange={(e) => setFecha(e.target.value)}
              required
            />
          </div>

          {/* Proveedor con autollenado readonly */}
          <div className="md:col-span-2">
            <label className="dt-label" htmlFor="proveedor">4 · Proveedor</label>
            <select
              id="proveedor" className="dt-input"
              value={proveedor?.id_proveedor ?? ''}
              onChange={(e) => setProveedor(proveedores.find((p) => p.id_proveedor === e.target.value) ?? null)}
              required
            >
              <option value="" disabled>Seleccione un proveedor…</option>
              {proveedores.map((p) => (
                <option key={p.id_proveedor} value={p.id_proveedor}>{p.razon_social}</option>
              ))}
            </select>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <div>
                <label className="dt-label">NIT / Documento</label>
                <input className="dt-input font-mono" readOnly value={proveedor?.nit_documento ?? ''} placeholder="—" />
              </div>
              <div>
                <label className="dt-label">Correo</label>
                <input className="dt-input" readOnly value={proveedor?.correo ?? ''} placeholder="—" />
              </div>
              <div>
                <label className="dt-label">Teléfono</label>
                <input className="dt-input" readOnly value={proveedor?.telefono ?? ''} placeholder="—" />
              </div>
            </div>
          </div>

          <div>
            <label className="dt-label" htmlFor="cantidad">5 · Cantidad</label>
            <input
              id="cantidad" type="number" min="0.01" step="0.01" inputMode="decimal"
              className="dt-input text-right font-mono" placeholder="0"
              value={cantidad} onChange={(e) => setCantidad(e.target.value)} required
            />
          </div>
          <div>
            <label className="dt-label" htmlFor="valor">6 · Valor unitario (S/)</label>
            <input
              id="valor" type="number" min="0" step="0.01" inputMode="decimal"
              className="dt-input text-right font-mono" placeholder="0.00"
              value={valor} onChange={(e) => setValor(e.target.value)} required
            />
          </div>

          <div>
            <label className="dt-label" htmlFor="factura">N° Factura</label>
            <input id="factura" className="dt-input font-mono" value={nroFactura} onChange={(e) => setNroFactura(e.target.value)} placeholder="F001-000123" />
          </div>
          <div>
            <label className="dt-label" htmlFor="orden">N° Orden Compra</label>
            <input id="orden" className="dt-input font-mono" value={nroOrden} onChange={(e) => setNroOrden(e.target.value)} placeholder="OC-2026-045" />
          </div>

          <div className="md:col-span-2">
            <label className="dt-label" htmlFor="concepto">Concepto</label>
            <input id="concepto" className="dt-input" value={concepto} onChange={(e) => setConcepto(e.target.value)} placeholder="Reposición de temporada…" />
          </div>
        </div>

        {/* Total reactivo + acciones */}
        <div className="costura my-6" />
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-[12px] font-semibold uppercase tracking-wider text-pizarra-400">Total de la entrada</p>
            <p className="text-[28px] font-extrabold tabular-nums text-pizarra-800">{moneda(total)}</p>
          </div>
          <div className="flex gap-3">
            <button type="button" className="dt-btn dt-btn-ghost" onClick={limpiar}>
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
    </div>
  );
}
