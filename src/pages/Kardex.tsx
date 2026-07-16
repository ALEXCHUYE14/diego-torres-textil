import { useEffect, useRef, useState } from 'react';
import { CalendarClock, CalendarDays, CalendarRange, ListChecks, RefreshCcw, ScanBarcode } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useToast } from '../context/ToastContext';
import { BuscadorProducto, DataTable, KpiCard, PageHeader } from '../components/ui';
import { DetalleProducto, Movimiento, MovimientoGeneral, Producto } from '../lib/types';
import { fechaMovimiento, fechaSegura, hoyISO, limitesFechaMovimiento, moneda, numero } from '../utils/format';

type Modo = 'MES' | 'ANIO' | 'HISTORICO';

export default function Kardex() {
  const { toast } = useToast();
  const [detalle, setDetalle] = useState<DetalleProducto | null>(null);
  const [noEncontrado, setNoEncontrado] = useState(false);
  const [movimientos, setMovimientos] = useState<Movimiento[]>([]);
  const [modo, setModo] = useState<Modo>('MES');
  const [anio, setAnio] = useState(new Date().getFullYear() - 1);
  const [cargando, setCargando] = useState(false);
  // Igual que en BuscadorProducto: si el usuario cambia de producto o de
  // modo (Mes/Año/Histórico) rápido, dos consultas quedan en vuelo a la
  // vez; sin esto, la que responde más tarde pisa a la más reciente y la
  // tabla mostrada deja de corresponder con el botón de modo resaltado.
  const idConsulta = useRef(0);

  const consultar = async (p: Producto, m: Modo = modo, a: number = anio) => {
    const idActual = ++idConsulta.current;
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
      if (idActual !== idConsulta.current) return;
      if (e1 || e2) { toast('error', (e1 ?? e2)!.message); return; }
      if (!det) { setNoEncontrado(true); setDetalle(null); setMovimientos([]); return; }
      setDetalle(det as DetalleProducto);
      setMovimientos((kdx as Movimiento[]) ?? []);
    } catch {
      if (idActual !== idConsulta.current) return;
      toast('error', 'Error de red al consultar el kardex. Verifique su conexión.');
    } finally {
      if (idActual === idConsulta.current) setCargando(false);
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

  // -------- Vista "Todos los movimientos": todo lo registrado en un rango
  // de fechas, sin tener que buscar artículo por artículo. Antes no existía
  // ninguna forma de ver de un vistazo todo lo digitado en el día. --------
  const [vistaGeneral, setVistaGeneral] = useState(false);
  const [desdeGeneral, setDesdeGeneral] = useState(hoyISO());
  const [hastaGeneral, setHastaGeneral] = useState(hoyISO());
  const [movimientosGenerales, setMovimientosGenerales] = useState<MovimientoGeneral[]>([]);
  const [cargandoGeneral, setCargandoGeneral] = useState(false);
  const limitesGeneral = limitesFechaMovimiento();

  const consultarGeneral = async (d = desdeGeneral, h = hastaGeneral) => {
    if (!d || !h) { toast('aviso', 'Seleccione fecha de inicio y fin'); return; }
    if (d > h) { toast('error', 'La fecha inicial no puede ser posterior a la final'); return; }
    setCargandoGeneral(true);
    try {
      const { data, error } = await supabase.rpc('rpc_kardex_general', { p_desde: d, p_hasta: h });
      if (error) { toast('error', error.message); return; }
      setMovimientosGenerales((data as MovimientoGeneral[]) ?? []);
    } catch {
      toast('error', 'Error de red al consultar el registro. Verifique su conexión.');
    } finally {
      setCargandoGeneral(false);
    }
  };

  // Carga el día de hoy apenas se entra a esta pestaña, para que el usuario
  // no tenga que pulsar "Actualizar" para ver algo la primera vez.
  useEffect(() => {
    if (vistaGeneral) consultarGeneral();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vistaGeneral]);

  return (
    <div>
      <PageHeader titulo="Detalle de producto y Kardex" subtitulo="Trazabilidad cronológica completa por prenda" />

      <div className="mb-6 flex flex-wrap gap-2">
        <button
          className={`dt-btn ${!vistaGeneral ? 'dt-btn-primary' : 'dt-btn-ghost'}`}
          onClick={() => setVistaGeneral(false)}
        >
          <ScanBarcode size={16} /> Por artículo
        </button>
        <button
          className={`dt-btn ${vistaGeneral ? 'dt-btn-primary' : 'dt-btn-ghost'}`}
          onClick={() => setVistaGeneral(true)}
        >
          <ListChecks size={16} /> Todos los movimientos
        </button>
      </div>

      {vistaGeneral ? (
        <>
          <div className="dt-card p-4 md:p-5">
            <div className="flex flex-col gap-3 md:flex-row md:items-end">
              <div className="flex-1">
                <label className="dt-label" htmlFor="kg-desde">Fecha inicio</label>
                <input
                  id="kg-desde" type="date" className="dt-input"
                  min={limitesGeneral.min} max={limitesGeneral.max}
                  value={desdeGeneral} onChange={(e) => setDesdeGeneral(e.target.value)}
                />
              </div>
              <div className="flex-1">
                <label className="dt-label" htmlFor="kg-hasta">Fecha fin</label>
                <input
                  id="kg-hasta" type="date" className="dt-input"
                  min={limitesGeneral.min} max={limitesGeneral.max}
                  value={hastaGeneral} onChange={(e) => setHastaGeneral(e.target.value)}
                />
              </div>
              <button
                className="dt-btn dt-btn-primary"
                onClick={() => consultarGeneral()}
                disabled={cargandoGeneral}
              >
                <RefreshCcw size={15} className={cargandoGeneral ? 'animate-spin' : ''} /> Actualizar
              </button>
            </div>
          </div>

          <div className="dt-card mt-6 p-5 md:p-6">
            <h3 className="mb-4 text-[16px] font-bold text-pizarra-800">
              {movimientosGenerales.length} movimiento{movimientosGenerales.length === 1 ? '' : 's'} registrado{movimientosGenerales.length === 1 ? '' : 's'}
              {cargandoGeneral && <span className="ml-2 text-[13px] font-normal text-pizarra-400">actualizando…</span>}
            </h3>
            <DataTable<MovimientoGeneral & Record<string, unknown>>
              columnas={[
                { clave: 'documento_numero', titulo: 'Documento', render: (m) => <span className="font-mono text-[12.5px]">{m.tipo_consecutivo}</span> },
                { clave: 'fecha_registro', titulo: 'Fecha', render: (m) => fechaMovimiento(m.fecha_registro) },
                { clave: 'naturaleza', titulo: 'Tipo', render: (m) => (
                  <span className={`rounded-full px-2.5 py-0.5 text-[11.5px] font-bold ${m.naturaleza === 'ENTRADA' ? 'bg-emerald-50 text-emerald-700' : 'bg-borgona-50 text-borgona-600'}`}>
                    {m.tipo_movimiento} · {m.naturaleza}
                  </span>
                )},
                { clave: 'producto_nombre', titulo: 'Producto', render: (m) => (
                  <div>
                    <p className="font-medium text-pizarra-800">{m.producto_nombre}</p>
                    <p className="font-mono text-[11px] text-pizarra-400">{m.producto_codigo}</p>
                  </div>
                )},
                { clave: 'cantidad', titulo: 'Cantidad', numerica: true, render: (m) => numero(m.cantidad) },
                { clave: 'valor_unitario', titulo: 'V. Unitario', numerica: true, render: (m) => moneda(m.valor_unitario) },
                { clave: 'valor_total', titulo: 'V. Total', numerica: true, render: (m) => moneda(m.valor_total) },
                { clave: 'proveedor', titulo: 'Proveedor', render: (m) => m.proveedor ?? '—' },
                { clave: 'usuario_nombre', titulo: 'Usuario', render: (m) => m.usuario_nombre ?? '—' },
              ]}
              filas={movimientosGenerales as Array<MovimientoGeneral & Record<string, unknown>>}
              porPagina={15}
              vacio={cargandoGeneral ? 'Cargando…' : 'Sin movimientos en el período seleccionado'}
              idDeFila={(m) => m.tipo_consecutivo}
            />
          </div>
        </>
      ) : (
        <>
          <div className="dt-card p-5 md:p-6">
            <label className="dt-label">Consultar producto</label>
            <BuscadorProducto onSeleccion={(p) => consultar(p)} autoFocus soloActivos={false} />
            {noEncontrado && (
              <p className="mt-3 text-[14px] font-semibold text-red-600">(Producto no encontrado)</p>
            )}
          </div>

          {detalle && (
            <>
              {/* -------- Cabecera del producto -------- */}
              <div className="dt-card mt-6 p-5 md:p-6">
                <div className="flex items-center gap-2">
                  <p className="font-mono text-[13px] text-indigo-600">{detalle.producto.codigo_barra}</p>
                  {!detalle.producto.activo && (
                    <span className="rounded-full bg-pizarra-100 px-2 py-0.5 text-[11px] font-semibold text-pizarra-500">Inactivo</span>
                  )}
                </div>
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
                    { clave: 'fecha_registro', titulo: 'Fecha', render: (m) => fechaMovimiento(m.fecha_registro) },
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
        </>
      )}
    </div>
  );
}
