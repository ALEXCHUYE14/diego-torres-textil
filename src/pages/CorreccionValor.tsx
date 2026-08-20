import { FormEvent, useMemo, useRef, useState } from 'react';
import { Eraser, Printer, Save, Wrench } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { BuscadorProducto, PageHeader } from '../components/ui';
import DocumentoImpreso from '../components/DocumentoImpreso';
import { DocumentoMovimiento, Producto, TIPO_CORRECCION_VALOR } from '../lib/types';
import { limitesFechaMovimiento, moneda, numero } from '../utils/format';

/**
 * Corrección de valor de inventario (RE-09 / tipo 9000) — exclusiva de
 * Administrador (también protegida en la ruta, ver App.tsx, y en el
 * servidor, ver rpc_corregir_valor_producto en migration_016).
 *
 * A propósito NO es una entrada normal: no pide cantidad ni proveedor, no
 * suma stock. Solo corrige el costo (costo_promedio_ponderado) con el que
 * ya está valorizado un artículo existente, dejando un rastro en el kardex
 * para trazabilidad (quién, cuándo, con qué valor anterior/nuevo).
 */
export default function CorreccionValor() {
  const { toast } = useToast();
  const { esAdministrador } = useAuth();
  const buscadorRef = useRef<HTMLInputElement>(null);

  const [producto, setProducto] = useState<Producto | null>(null);
  const [valorNuevo, setValorNuevo] = useState('');
  // Vacía a propósito, igual que en Entradas/Salidas: obliga a elegir la
  // fecha a mano en vez de asumir "hoy" sin que el usuario se dé cuenta.
  const [fecha, setFecha] = useState('');
  const [concepto, setConcepto] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [documentoGuardado, setDocumentoGuardado] = useState<DocumentoMovimiento | null>(null);

  const limites = useMemo(limitesFechaMovimiento, []);

  const valorNum = parseFloat(valorNuevo);
  const impacto = producto && !isNaN(valorNum)
    ? (valorNum - producto.costo_promedio_ponderado) * producto.stock_real
    : null;

  const elegirProducto = (p: Producto) => {
    setProducto(p);
    setValorNuevo('');
  };

  const limpiar = () => {
    setProducto(null); setValorNuevo(''); setFecha(''); setConcepto('');
    buscadorRef.current?.focus();
  };

  // Igual que en Entradas: distinto del reseteo automático post-guardado,
  // este lo dispara el usuario a propósito para empezar de cero, así que
  // también oculta el aviso de éxito de la corrección anterior.
  const limpiarManual = () => {
    setDocumentoGuardado(null);
    limpiar();
  };

  const guardar = async (e: FormEvent) => {
    e.preventDefault();
    setDocumentoGuardado(null);
    if (!producto) { toast('aviso', 'Busque y seleccione el artículo a corregir'); return; }
    if (!fecha) { toast('aviso', 'Seleccione la fecha del movimiento'); return; }
    if (valorNuevo.trim() === '' || isNaN(valorNum) || valorNum < 0) {
      toast('error', 'Ingrese un valor nuevo válido (mayor o igual a 0)');
      return;
    }
    if (valorNum === producto.costo_promedio_ponderado) {
      toast('aviso', 'El valor nuevo es igual al valor actual del producto: no hay nada que corregir');
      return;
    }

    setGuardando(true);
    try {
      const { data, error } = await supabase.rpc('rpc_corregir_valor_producto', {
        p_producto_id: producto.id_producto,
        p_valor_nuevo: valorNum,
        p_fecha: fecha,
        p_concepto: concepto || null,
      });
      if (error) {
        toast('error', error.message.replace(/^.*?:/, '').trim() || 'No se pudo registrar la corrección');
        return;
      }
      toast('exito', `Valor corregido con éxito · Documento ${data.consecutivo}`);
      try {
        const { data: doc } = await supabase.rpc('rpc_obtener_documento', { p_tipo: 'ENTRADA_ALMACEN', p_numero: data.consecutivo });
        setDocumentoGuardado(doc as DocumentoMovimiento);
      } catch {
        toast('aviso', 'La corrección se guardó, pero no se pudo cargar la vista de impresión. Búsquela desde Imprimir.');
      }
      limpiar();
    } catch {
      toast('error', 'Error de red al registrar la corrección. Verifique su conexión e intente nuevamente.');
    } finally {
      setGuardando(false);
    }
  };

  return (
    <div>
      <PageHeader
        titulo="Corrección de valor de inventario"
        subtitulo={`Tipo ${TIPO_CORRECCION_VALOR.codigo} — corrige el costo de un artículo sin alterar su stock · exclusivo de Administrador`}
      />

      <form onSubmit={guardar} className="dt-card p-5 md:p-7 print:hidden">
        <label className="dt-label">Artículo a corregir</label>
        <BuscadorProducto onSeleccion={elegirProducto} inputRef={buscadorRef} autoFocus disabled={guardando} placeholder="Busque el artículo cuyo valor desea corregir…" />

        {producto && (
          <div className="mt-4 rounded-xl border border-pizarra-200 px-4 py-3">
            <p className="text-[14px] font-semibold text-pizarra-800">{producto.nombre}</p>
            <p className="text-[12px] text-pizarra-500">
              {[producto.color, producto.talla].filter(Boolean).join(' · ') || producto.codigo_barra}
              {' · Stock actual: '}{numero(producto.stock_real)}
            </p>
            <p className="mt-1 text-[13px] text-pizarra-600">
              Valor actual (CPP): <span className="font-mono font-semibold">{moneda(producto.costo_promedio_ponderado)}</span>
            </p>
          </div>
        )}

        <div className="mt-5 grid gap-5 md:grid-cols-2">
          <div>
            <label className="dt-label" htmlFor="valor-nuevo">Valor nuevo (unitario)</label>
            <input
              id="valor-nuevo" type="number" min="0" step="0.01" inputMode="decimal"
              className="dt-input font-mono" placeholder="90870"
              value={valorNuevo} disabled={guardando || !producto}
              onChange={(e) => setValorNuevo(e.target.value)}
            />
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
            <label className="dt-label" htmlFor="concepto">Concepto</label>
            <input
              id="concepto" className="dt-input" value={concepto} disabled={guardando}
              onChange={(e) => setConcepto(e.target.value)}
              placeholder="Corrección de costo cargado con error en el saldo inicial…"
            />
          </div>
        </div>

        {producto && impacto !== null && (
          <div className="costura my-6" />
        )}
        {producto && impacto !== null && (
          <div>
            <p className="text-[12px] font-semibold uppercase tracking-wider text-pizarra-400">Impacto en la valorización del saldo actual</p>
            <p className={`text-[24px] font-extrabold tabular-nums ${impacto < 0 ? 'text-borgona-600' : 'text-emerald-600'}`}>
              {impacto >= 0 ? '+' : ''}{moneda(impacto)}
            </p>
          </div>
        )}

        <div className="costura my-6" />
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-end">
          <div className="flex gap-3">
            <button type="button" className="dt-btn dt-btn-ghost" onClick={limpiarManual} disabled={guardando}>
              <Eraser size={17} /> Limpiar
            </button>
            <button type="submit" className="dt-btn dt-btn-primary" disabled={guardando || !esAdministrador}>
              {guardando ? <Save size={17} className="animate-pulse" /> : <Wrench size={17} />}
              {guardando ? 'Guardando…' : 'Guardar corrección'}
            </button>
          </div>
        </div>
        {!esAdministrador && (
          <p className="mt-4 rounded-[10px] bg-amber-50 px-4 py-2.5 text-[13px] text-amber-700">
            Esta corrección es exclusiva del rol <strong>Administrador</strong>.
          </p>
        )}
      </form>

      {documentoGuardado && (
        <div className="dt-card mt-6 flex flex-col items-start gap-3 border-emerald-200 bg-emerald-50 p-5 sm:flex-row sm:items-center sm:justify-between print:hidden">
          <div>
            <p className="text-[13px] font-semibold text-emerald-700">Valor corregido con éxito</p>
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
