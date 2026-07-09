import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpFromLine, Eraser, Save, TriangleAlert } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { BuscadorProducto, PageHeader } from '../components/ui';
import { Producto, Proveedor, TIPOS_SALIDA } from '../lib/types';
import { moneda, numero } from '../utils/format';
import { borrarBorrador, CLAVE_BORRADOR_SALIDA, guardarBorrador, leerBorrador } from '../utils/borrador';

interface BorradorSalida {
  producto: Producto | null;
  tipoMov: string;
  proveedorId: string;
  cantidad: string;
  concepto: string;
}

export default function Salidas() {
  const { toast } = useToast();
  const { esOperativo, session } = useAuth();
  const uid = session?.user.id ?? '';
  const buscadorRef = useRef<HTMLInputElement>(null);
  const avisado = useRef(false);
  const restaurado = useRef(false);

  const [proveedores, setProveedores] = useState<Proveedor[]>([]);
  const [producto, setProducto] = useState<Producto | null>(null);
  const [tipoMov, setTipoMov] = useState('2000');
  const [proveedor, setProveedor] = useState<Proveedor | null>(null);
  const [cantidad, setCantidad] = useState('');
  const [concepto, setConcepto] = useState('');
  const [guardando, setGuardando] = useState(false);

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

  // Restaura el borrador (si existe y pertenece al usuario actual) una vez
  // que los proveedores ya cargaron, para poder resolver el id guardado.
  useEffect(() => {
    if (!uid || restaurado.current || proveedores.length === 0) return;
    restaurado.current = true;
    const b = leerBorrador<BorradorSalida>(CLAVE_BORRADOR_SALIDA, uid);
    if (!b) return;
    setProducto(b.producto); setTipoMov(b.tipoMov); setCantidad(b.cantidad);
    setProveedor(proveedores.find((p) => p.id_proveedor === b.proveedorId) ?? null);
    setConcepto(b.concepto);
    toast('aviso', 'Se restauró un formulario de salida sin guardar');
  }, [uid, proveedores, toast]);

  useEffect(() => {
    if (!uid) return;
    const b: BorradorSalida = {
      producto, tipoMov, proveedorId: proveedor?.id_proveedor ?? '', cantidad, concepto,
    };
    guardarBorrador(CLAVE_BORRADOR_SALIDA, uid, b);
  }, [uid, producto, tipoMov, proveedor, cantidad, concepto]);

  const cantidadNum = parseFloat(cantidad) || 0;
  const stockDisponible = producto?.stock_real ?? 0;
  const excedeStock = producto !== null && cantidadNum > stockDisponible;

  // Valor de solo lectura: costo promedio ponderado del inventario
  const valorUnitario = producto?.costo_promedio_ponderado ?? 0;
  const total = useMemo(() => cantidadNum * valorUnitario, [cantidadNum, valorUnitario]);

  const cambiaCantidad = (v: string) => {
    setCantidad(v);
    const n = parseFloat(v) || 0;
    // Validación crítica en tiempo real: alerta Toast roja al superar el stock
    if (producto && n > producto.stock_real) {
      if (!avisado.current) {
        toast('error', `Stock insuficiente: disponible ${numero(producto.stock_real)} unidades`);
        avisado.current = true;
      }
    } else {
      avisado.current = false;
    }
  };

  const limpiar = () => {
    setProducto(null); setTipoMov('2000'); setProveedor(null); setCantidad('');
    setConcepto('');
    avisado.current = false;
    borrarBorrador(CLAVE_BORRADOR_SALIDA);
    buscadorRef.current?.focus();
  };

  const guardar = async (e: FormEvent) => {
    e.preventDefault();
    if (!producto) { toast('aviso', 'Seleccione un producto'); return; }
    if (cantidadNum <= 0) { toast('error', 'La cantidad debe ser mayor a 0'); return; }
    if (excedeStock) {
      toast('error', `Registro bloqueado: la cantidad supera el stock disponible (${numero(stockDisponible)})`);
      return;
    }

    setGuardando(true);
    try {
      const { data, error } = await supabase.rpc('rpc_registrar_salida', {
        p_producto_id: producto.id_producto,
        p_tipo_movimiento: tipoMov,
        p_cantidad: cantidadNum,
        p_proveedor_id: proveedor?.id_proveedor ?? null,
        p_concepto: concepto || null,
      });
      if (error) {
        let msg = error.message;
        if (msg.includes('STOCK_INSUFICIENTE')) {
          msg = 'Stock insuficiente: otro usuario registró movimientos. Actualice el producto.';
        } else if (msg.includes('PERIODO_CERRADO')) {
          msg = msg.replace(/^.*?:/, '').trim();
        }
        toast('error', msg);
        return;
      }
      toast('exito', `Salida guardada con éxito · ${data.consecutivo}`);
      limpiar();
    } catch {
      toast('error', 'Error de red al registrar la salida. Verifique su conexión e intente nuevamente.');
    } finally {
      setGuardando(false);
    }
  };

  return (
    <div>
      <PageHeader
        titulo="Salidas de almacén"
        subtitulo="Despacho y ventas · el valor se calcula por costo promedio ponderado"
      />

      <form onSubmit={guardar} className="dt-card p-5 md:p-7">
        <div className="grid gap-5 md:grid-cols-2">
          <div className="md:col-span-2">
            <label className="dt-label">1 · Producto</label>
            <BuscadorProducto onSeleccion={(p) => { setProducto(p); avisado.current = false; }} inputRef={buscadorRef} autoFocus />
            {producto && (
              <div className={`mt-3 rounded-[10px] border px-4 py-3 transition ${excedeStock ? 'border-red-300 bg-red-50' : 'border-indigo-600/25 bg-indigo-600/[0.04]'}`}>
                <p className="font-mono text-[12.5px] text-indigo-600">{producto.codigo_barra}</p>
                <p className="text-[14px] font-semibold text-pizarra-800">
                  {producto.nombre} · {producto.genero} · {producto.color} · Talla {producto.talla}
                </p>
                <p className={`text-[12.5px] ${excedeStock ? 'text-red-600 font-semibold' : 'text-pizarra-500'}`}>
                  Stock disponible: <strong>{numero(producto.stock_real)}</strong>
                </p>
              </div>
            )}
          </div>

          <div>
            <label className="dt-label" htmlFor="tipo-sal">2 · Tipo de movimiento</label>
            <select id="tipo-sal" className="dt-input" value={tipoMov} onChange={(e) => setTipoMov(e.target.value)}>
              {TIPOS_SALIDA.map((t) => (
                <option key={t.codigo} value={t.codigo}>{t.codigo} — {t.nombre}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="dt-label" htmlFor="cant-sal">3 · Cantidad</label>
            <input
              id="cant-sal" type="number" min="0.01" step="0.01" inputMode="decimal"
              className={`dt-input text-right font-mono ${excedeStock ? '!border-red-400 !ring-4 !ring-red-500/10' : ''}`}
              placeholder="0" value={cantidad}
              onChange={(e) => cambiaCantidad(e.target.value)} required
              aria-invalid={excedeStock}
            />
            {excedeStock && (
              <p className="mt-1.5 flex items-center gap-1.5 text-[12.5px] font-semibold text-red-600">
                <TriangleAlert size={14} /> Supera el stock disponible · no se permiten stocks negativos
              </p>
            )}
          </div>

          <div>
            <label className="dt-label" htmlFor="valor-sal">Valor unitario (CPP · solo lectura)</label>
            <input id="valor-sal" className="dt-input text-right font-mono" readOnly value={producto ? moneda(valorUnitario) : ''} placeholder="—" />
          </div>

          <div className="md:col-span-2">
            <label className="dt-label" htmlFor="proveedor-sal">Proveedor</label>
            <select
              id="proveedor-sal" className="dt-input"
              value={proveedor?.id_proveedor ?? ''}
              onChange={(e) => setProveedor(proveedores.find((p) => p.id_proveedor === e.target.value) ?? null)}
            >
              <option value="">Sin proveedor asociado</option>
              {proveedores.map((p) => (
                <option key={p.id_proveedor} value={p.id_proveedor}>{p.razon_social}</option>
              ))}
            </select>
          </div>

          <div className="md:col-span-2">
            <label className="dt-label" htmlFor="conc-sal">Concepto</label>
            <input id="conc-sal" className="dt-input" value={concepto} onChange={(e) => setConcepto(e.target.value)} placeholder="Despacho a tienda…" />
          </div>
        </div>

        <div className="costura my-6" />
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-[12px] font-semibold uppercase tracking-wider text-pizarra-400">Total de la salida</p>
            <p className="text-[28px] font-extrabold tabular-nums text-pizarra-800">{moneda(total)}</p>
          </div>
          <div className="flex gap-3">
            <button type="button" className="dt-btn dt-btn-ghost" onClick={limpiar}>
              <Eraser size={17} /> Limpiar
            </button>
            <button type="submit" className="dt-btn dt-btn-primary" disabled={guardando || excedeStock || !esOperativo}>
              {guardando ? <Save size={17} className="animate-pulse" /> : <ArrowUpFromLine size={17} />}
              {guardando ? 'Guardando…' : 'Guardar salida'}
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
