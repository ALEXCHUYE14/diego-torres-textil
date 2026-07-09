import { useState } from 'react';
import { CalendarClock, CalendarDays, CalendarRange } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useToast } from '../context/ToastContext';
import { BuscadorProducto, DataTable, KpiCard, PageHeader } from '../components/ui';
import { DetalleProducto, Movimiento, Producto } from '../lib/types';
import { fechaSegura, moneda, numero } from '../utils/format';

type Modo = 'MES' | 'ANIO' | 'HISTORICO';

export default function Kardex() {
  const { toast } = useToast();
  const [detalle, setDetalle] = useState<DetalleProducto | null>(null);
  const [noEncontrado, setNoEncontrado] = useState(false);
  const [movimientos, setMovimientos] = useState<Movimiento[]>([]);
  const [modo, setModo] = useState<Modo>('MES');
  const [anio, setAnio] = useState(new Date().getFullYear() - 1);
  const [cargando, setCargando] = useState(false);

  const consultar = async (p: Producto, m: Modo = modo, a: number = anio) => {
    setCargando(true);
    setNoEncontrado(false);
    try {
      const [{ data: det, error: e1 }, { data: kdx, error: e2 }] = await Promise.all([
        supabase.rpc('rpc_detalle_producto', { p_producto_id: p.id_producto }),
        supabase.rpc('rpc_kardex_producto', {
          p_producto_id: p.id_producto,
          p_modo: m,
          p_anio: m === 'HISTORICO' ? a : null,
        }),
      ]);
      if (e1 || e2) { toast('error', (e1 ?? e2)!.message); return; }
      if (!det) { setNoEncontrado(true); setDetalle(null); setMovimientos([]); return; }
      setDetalle(det as DetalleProducto);
      setMovimientos((kdx as Movimiento[]) ?? []);
    } catch {
      toast('error', 'Error de red al consultar el kardex. Verifique su conexión.');
    } finally {
      setCargando(false);
    }
  };

  const cambiarModo = (m: Modo, a?: number) => {
    setModo(m);
    if (a !== undefined) setAnio(a);
    if (detalle) {
      consultar(detalle.producto, m, a ?? anio);
    }
  };

  const aniosHistoricos = Array.from({ length: 6 }, (_, i) => new Date().getFullYear() - 1 - i);

  return (
    <div>
      <PageHeader titulo="Detalle de producto y Kardex" subtitulo="Trazabilidad cronológica completa por prenda" />

      <div className="dt-card p-5 md:p-6">
        <label className="dt-label">Consultar producto</label>
        <BuscadorProducto onSeleccion={(p) => consultar(p)} autoFocus />
        {noEncontrado && (
          <p className="mt-3 text-[14px] font-semibold text-red-600">(Producto no encontrado)</p>
        )}
      </div>

      {detalle && (
        <>
          {/* -------- Cabecera del producto -------- */}
          <div className="dt-card mt-6 p-5 md:p-6">
            <p className="font-mono text-[13px] text-indigo-600">{detalle.producto.codigo_barra}</p>
            <h2 className="mt-1 text-[20px] font-bold text-pizarra-800">
              {[detalle.producto.nombre, detalle.producto.genero, detalle.producto.color, detalle.producto.talla && `Talla ${detalle.producto.talla}`]
                .filter(Boolean).join(' · ')}
            </h2>
            <p className="mt-1 text-[13px] text-pizarra-500">Creado el {fechaSegura(detalle.producto.fecha_creacion)}</p>
          </div>

          {/* -------- KPIs financieros -------- */}
          <div className="mt-5 grid grid-cols-2 gap-3.5 md:grid-cols-5">
            <KpiCard titulo="Stock inicial (mes)" valor={numero(detalle.stock_inicial)} />
            <KpiCard titulo="Entradas del mes" valor={numero(detalle.entradas_mes)} />
            <KpiCard titulo="Salidas del mes" valor={numero(detalle.salidas_mes)} />
            <KpiCard titulo="Consumo diario" valor={numero(detalle.consumo_promedio)} sufijo="und/día" />
            <KpiCard titulo="Duración" valor={numero(detalle.duracion_dias)} sufijo="días" />
            <KpiCard titulo="Existencias" valor={numero(detalle.existencias)} acento />
            <KpiCard titulo="Valorización saldo" valor={moneda(detalle.valorizacion)} acento />
            <KpiCard titulo="Valor ajustable" valor={moneda(detalle.valor_ajustable)} />
            <KpiCard titulo="Valor reposición" valor={moneda(detalle.valor_reposicion)} />
            <KpiCard titulo="Valor actual (CPP)" valor={moneda(detalle.valor_actual)} />
          </div>

          {/* -------- Grid del kardex -------- */}
          <div className="dt-card mt-6 p-5 md:p-6">
            <h3 className="mb-4 text-[16px] font-bold text-pizarra-800">
              Kardex {modo === 'MES' ? 'del mes' : modo === 'ANIO' ? 'del año' : `histórico ${anio}`}
              {cargando && <span className="ml-2 text-[13px] font-normal text-pizarra-400">actualizando…</span>}
            </h3>
            <DataTable<Movimiento & Record<string, unknown>>
              columnas={[
                { clave: 'tipo_consecutivo', titulo: 'Consecutivo', render: (m) => <span className="font-mono text-[12.5px]">{m.tipo_consecutivo}</span> },
                { clave: 'fecha_registro', titulo: 'Fecha', render: (m) => fechaSegura(m.fecha_registro) },
                { clave: 'naturaleza', titulo: 'Tipo', render: (m) => (
                  <span className={`rounded-full px-2.5 py-0.5 text-[11.5px] font-bold ${m.naturaleza === 'ENTRADA' ? 'bg-emerald-50 text-emerald-700' : 'bg-borgona-50 text-borgona-600'}`}>
                    {m.tipo_movimiento} · {m.naturaleza}
                  </span>
                )},
                { clave: 'cantidad', titulo: 'Cantidad', numerica: true, render: (m) => numero(m.cantidad) },
                { clave: 'valor_unitario', titulo: 'V. Unitario', numerica: true, render: (m) => moneda(m.valor_unitario) },
                { clave: 'valor_total', titulo: 'V. Total', numerica: true, render: (m) => moneda(m.valor_total) },
                { clave: 'proveedor', titulo: 'Proveedor', render: (m) => m.proveedor ?? '—' },
                { clave: 'stock_resultante', titulo: 'Saldo', numerica: true, render: (m) => numero(m.stock_resultante) },
              ]}
              filas={movimientos as Array<Movimiento & Record<string, unknown>>}
              porPagina={10}
              vacio="Sin movimientos en el período"
            />

            {/* -------- Segmentación: tres botones en la base -------- */}
            <div className="costura my-5" />
            <div className="flex flex-wrap items-center gap-2.5">
              <button className={`dt-btn ${modo === 'MES' ? 'dt-btn-primary' : 'dt-btn-ghost'}`} onClick={() => cambiarModo('MES')}>
                <CalendarDays size={16} /> Kardex Mes
              </button>
              <button className={`dt-btn ${modo === 'ANIO' ? 'dt-btn-primary' : 'dt-btn-ghost'}`} onClick={() => cambiarModo('ANIO')}>
                <CalendarRange size={16} /> Kardex Año
              </button>
              <button className={`dt-btn ${modo === 'HISTORICO' ? 'dt-btn-primary' : 'dt-btn-ghost'}`} onClick={() => cambiarModo('HISTORICO')}>
                <CalendarClock size={16} /> Años anteriores
              </button>
              {modo === 'HISTORICO' && (
                <select className="dt-input !w-auto" value={anio} onChange={(e) => cambiarModo('HISTORICO', Number(e.target.value))} aria-label="Año histórico">
                  {aniosHistoricos.map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
