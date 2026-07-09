import { useEffect, useState } from 'react';
import { Eraser, FileDown, Lock, RefreshCcw, Unlock } from 'lucide-react';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { DataTable, KpiCard, PageHeader } from '../components/ui';
import { FilaInforme, InformeCierre, PeriodoBloqueado } from '../lib/types';
import { hoyISO, moneda, numero } from '../utils/format';

const inicioMes = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
};

const etiquetaMes = (anioMes: string): string => {
  const [y, m] = anioMes.slice(0, 7).split('-');
  return `${m}/${y}`;
};

export default function Dashboard() {
  const { toast } = useToast();
  const { esOperativo } = useAuth();
  const [desde, setDesde] = useState(inicioMes());
  const [hasta, setHasta] = useState(hoyISO());
  const [informe, setInforme] = useState<InformeCierre | null>(null);
  const [cargando, setCargando] = useState(false);

  const [periodos, setPeriodos] = useState<PeriodoBloqueado[]>([]);
  const [mesSeleccionado, setMesSeleccionado] = useState(() => hoyISO().slice(0, 7));
  const [procesandoPeriodo, setProcesandoPeriodo] = useState(false);

  const actualizar = async (d = desde, h = hasta) => {
    if (!d || !h) { toast('aviso', 'Seleccione fecha de inicio y fin'); return; }
    if (d > h) { toast('error', 'La fecha inicial no puede ser posterior a la final'); return; }
    setCargando(true);
    try {
      const { data, error } = await supabase.rpc('rpc_informe_cierre', { p_desde: d, p_hasta: h });
      if (error) { toast('error', error.message); return; }
      setInforme(data as InformeCierre);
    } catch {
      toast('error', 'Error de red al actualizar el informe. Verifique su conexión.');
    } finally {
      setCargando(false);
    }
  };

  const cargarPeriodos = async () => {
    try {
      const { data, error } = await supabase
        .from('periodos_bloqueados')
        .select('*')
        .order('anio_mes', { ascending: false });
      if (error) return; // silencioso: no bloquea la carga del informe si la tabla aún no existe
      setPeriodos((data as PeriodoBloqueado[]) ?? []);
    } catch {
      // sin conexión: el resto del panel sigue funcionando
    }
  };

  useEffect(() => {
    actualizar(); // carga inicial del mes en curso
    cargarPeriodos();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const estaBloqueado = (anioMes: string) => periodos.some((p) => p.anio_mes.slice(0, 7) === anioMes);

  const cerrarPeriodo = async () => {
    if (!mesSeleccionado) return;
    setProcesandoPeriodo(true);
    try {
      const { error } = await supabase.rpc('rpc_bloquear_periodo', { p_anio_mes: `${mesSeleccionado}-01` });
      if (error) { toast('error', error.message); return; }
      toast('exito', `Período ${etiquetaMes(mesSeleccionado)} cerrado. No se podrán registrar movimientos en ese mes.`);
      cargarPeriodos();
    } catch {
      toast('error', 'Error de red al cerrar el período. Verifique su conexión.');
    } finally {
      setProcesandoPeriodo(false);
    }
  };

  const reabrirPeriodo = async (anioMes: string) => {
    setProcesandoPeriodo(true);
    try {
      const { error } = await supabase.rpc('rpc_desbloquear_periodo', { p_anio_mes: anioMes });
      if (error) { toast('error', error.message); return; }
      toast('exito', `Período ${etiquetaMes(anioMes)} reabierto`);
      cargarPeriodos();
    } catch {
      toast('error', 'Error de red al reabrir el período. Verifique su conexión.');
    } finally {
      setProcesandoPeriodo(false);
    }
  };

  const limpiarFechas = () => {
    const d = inicioMes(); const h = hoyISO();
    setDesde(d); setHasta(h);
    actualizar(d, h);
  };

  const generarPDF = () => {
    if (!informe) { toast('aviso', 'Actualice los datos antes de generar el PDF'); return; }
    const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });

    doc.setFillColor(30, 41, 59);
    doc.rect(0, 0, 297, 22, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(15);
    doc.text('DIEGO TORRES · Informe de Cierre de Inventario', 14, 10);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.text(`Período: ${desde} al ${hasta} · Generado: ${new Date().toLocaleString('es-PE')}`, 14, 17);

    doc.setTextColor(30, 41, 59);
    autoTable(doc, {
      startY: 30,
      theme: 'grid',
      styles: { fontSize: 8.5, cellPadding: 2 },
      headStyles: { fillColor: [79, 70, 229] },
      head: [['Stock Inicial', 'Entradas', 'Salidas', 'Stock Final', 'Rotación', 'Cobertura', 'Prom. Ent.', 'Prom. Sal.', 'Valor Inicial', 'Valor Final', 'Ocupación']],
      body: [[
        numero(informe.stock_inicial), numero(informe.entradas), numero(informe.salidas),
        numero(informe.stock_final), String(informe.rotacion), `${informe.cobertura_dias} días`,
        numero(informe.promedio_entradas), numero(informe.promedio_salidas),
        moneda(informe.valor_inicial), moneda(informe.valor_final), `${informe.ocupacion_pct}%`,
      ]],
    });

    let y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 7;
    doc.setFontSize(9.5);
    doc.text(`Producto top del período: ${informe.producto_top}`, 14, y);
    doc.text(`Producto con mayor stock: ${informe.producto_mayor_stock}`, 14, y + 5.5);

    autoTable(doc, {
      startY: y + 11,
      styles: { fontSize: 8, cellPadding: 1.8 },
      headStyles: { fillColor: [30, 41, 59] },
      head: [['Código', 'Descripción', 'Stock Inicial', 'Entradas', 'Salidas', 'Stock Final', 'Valor Total']],
      body: informe.grid.map((f) => [
        f.codigo, f.descripcion, numero(f.stock_inicial), numero(f.entradas),
        numero(f.salidas), numero(f.stock_final), moneda(f.valor_total),
      ]),
      columnStyles: { 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' }, 6: { halign: 'right' } },
    });

    doc.save(`Informe_Cierre_${desde}_${hasta}.pdf`);
    toast('exito', 'Informe PDF generado con éxito');
  };

  return (
    <div>
      <PageHeader
        titulo="Informe de cierre"
        subtitulo="Panel consolidado de inventario · reemplaza el cierre manual en Excel"
      />

      {/* -------- Control de cierre / bloqueo de mes -------- */}
      <div className="dt-card mb-6 p-4 md:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h3 className="flex items-center gap-2 text-[14px] font-bold text-pizarra-800">
              <Lock size={15} className="text-borgona-600" /> Cierre de mes
            </h3>
            <p className="mt-1 text-[12.5px] text-pizarra-500">
              Bloquea un período contable: mientras esté cerrado, no se podrán registrar entradas ni salidas con fecha dentro de ese mes.
            </p>
          </div>
          <div className="flex items-end gap-2">
            <div>
              <label className="dt-label" htmlFor="mes-cierre">Mes</label>
              <input
                id="mes-cierre" type="month" className="dt-input !w-auto"
                value={mesSeleccionado} onChange={(e) => setMesSeleccionado(e.target.value)}
                disabled={!esOperativo}
              />
            </div>
            <button
              className="dt-btn dt-btn-danger"
              disabled={!esOperativo || procesandoPeriodo || !mesSeleccionado || estaBloqueado(mesSeleccionado)}
              onClick={cerrarPeriodo}
            >
              <Lock size={15} /> Cerrar mes
            </button>
          </div>
        </div>

        {periodos.length > 0 && (
          <>
            <div className="costura my-4" />
            <p className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-pizarra-400">Períodos cerrados</p>
            <ul className="flex flex-wrap gap-2">
              {periodos.map((p) => (
                <li key={p.anio_mes} className="flex items-center gap-2 rounded-full border border-borgona-100 bg-borgona-50 px-3 py-1.5 text-[12.5px] font-medium text-borgona-600">
                  <Lock size={12} /> {etiquetaMes(p.anio_mes)}
                  {esOperativo && (
                    <button
                      type="button"
                      onClick={() => reabrirPeriodo(p.anio_mes)}
                      disabled={procesandoPeriodo}
                      className="rounded-full p-0.5 transition hover:bg-borgona-100 hover:text-borgona-800"
                      aria-label={`Reabrir período ${etiquetaMes(p.anio_mes)}`}
                    >
                      <Unlock size={12} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
        {!esOperativo && (
          <p className="mt-3 text-[12.5px] text-pizarra-400">Su rol es Consulta: puede ver el estado de los períodos, pero no cerrarlos ni reabrirlos.</p>
        )}
      </div>

      {/* -------- Filtros globales -------- */}
      <div className="dt-card p-4 md:p-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-end">
          <div className="flex-1">
            <label className="dt-label" htmlFor="f-desde">Fecha inicio</label>
            <input id="f-desde" type="date" className="dt-input" value={desde} onChange={(e) => setDesde(e.target.value)} />
          </div>
          <div className="flex-1">
            <label className="dt-label" htmlFor="f-hasta">Fecha fin</label>
            <input id="f-hasta" type="date" className="dt-input" value={hasta} onChange={(e) => setHasta(e.target.value)} />
          </div>
          <div className="grid grid-cols-3 gap-2 sm:flex sm:flex-wrap sm:gap-2.5">
            <button
              className="dt-btn dt-btn-primary !px-2 !py-2 !text-[12px] sm:!px-4 sm:!py-2.5 sm:!text-[14px]"
              onClick={() => actualizar()} disabled={cargando}
            >
              <RefreshCcw size={15} className={`shrink-0 ${cargando ? 'animate-spin' : ''}`} />
              <span className="truncate">Actualizar</span>
            </button>
            <button
              className="dt-btn dt-btn-ghost !px-2 !py-2 !text-[12px] sm:!px-4 sm:!py-2.5 sm:!text-[14px]"
              onClick={limpiarFechas}
            >
              <Eraser size={15} className="shrink-0" /> <span className="truncate">Limpiar</span>
            </button>
            <button
              className="dt-btn dt-btn-ghost !px-2 !py-2 !text-[12px] sm:!px-4 sm:!py-2.5 sm:!text-[14px]"
              onClick={generarPDF}
            >
              <FileDown size={15} className="shrink-0" /> <span className="truncate">PDF</span>
            </button>
          </div>
        </div>
      </div>

      {informe && (
        <>
          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            {/* -------- Bloque izquierdo: Volumen -------- */}
            <section>
              <h2 className="mb-3 text-[13px] font-bold uppercase tracking-[0.14em] text-pizarra-400">Volumen</h2>
              <div className="grid grid-cols-2 gap-3.5 sm:grid-cols-3">
                <KpiCard titulo="Stock inicial" valor={numero(informe.stock_inicial)} />
                <KpiCard titulo="Entradas" valor={numero(informe.entradas)} />
                <KpiCard titulo="Salidas" valor={numero(informe.salidas)} />
                <KpiCard titulo="Stock final" valor={numero(informe.stock_final)} acento />
                <KpiCard titulo="Índice de rotación" valor={String(informe.rotacion)} />
                <KpiCard titulo="Cobertura" valor={numero(informe.cobertura_dias)} sufijo="días" />
              </div>
            </section>

            {/* -------- Bloque derecho: Rendimiento / Financiero -------- */}
            <section>
              <h2 className="mb-3 text-[13px] font-bold uppercase tracking-[0.14em] text-pizarra-400">Rendimiento · Financiero</h2>
              <div className="grid grid-cols-2 gap-3.5 sm:grid-cols-3">
                <KpiCard titulo="Prom. entradas/día" valor={numero(informe.promedio_entradas)} />
                <KpiCard titulo="Prom. salidas/día" valor={numero(informe.promedio_salidas)} />
                <KpiCard titulo="Ocupación almacén" valor={`${informe.ocupacion_pct}%`} />
                <KpiCard titulo="Valor inventario inicial" valor={moneda(informe.valor_inicial)} />
                <KpiCard titulo="Valor inventario final" valor={moneda(informe.valor_final)} acento />
                <div className="dt-card col-span-2 p-4 sm:col-span-1">
                  <p className="text-[12px] font-semibold uppercase tracking-wider text-pizarra-400">Producto top</p>
                  <p className="mt-1.5 text-[13px] font-semibold leading-snug text-pizarra-800">{informe.producto_top}</p>
                  <p className="mt-2 text-[11.5px] text-pizarra-400">Mayor stock: {informe.producto_mayor_stock}</p>
                </div>
              </div>
            </section>
          </div>

          {/* -------- Grid dinámico -------- */}
          <div className="dt-card mt-6 p-5 md:p-6">
            <h3 className="mb-4 text-[16px] font-bold text-pizarra-800">Detalle por artículo</h3>
            <DataTable<FilaInforme & Record<string, unknown>>
              columnas={[
                { clave: 'codigo', titulo: 'Código', render: (f) => <span className="font-mono text-[12px] text-indigo-600">{f.codigo}</span> },
                { clave: 'descripcion', titulo: 'Descripción' },
                { clave: 'stock_inicial', titulo: 'Stock Inicial', numerica: true, render: (f) => numero(f.stock_inicial) },
                { clave: 'entradas', titulo: 'Entradas', numerica: true, render: (f) => numero(f.entradas) },
                { clave: 'salidas', titulo: 'Salidas', numerica: true, render: (f) => numero(f.salidas) },
                { clave: 'stock_final', titulo: 'Stock Final', numerica: true, render: (f) => numero(f.stock_final) },
                { clave: 'valor_total', titulo: 'Valor Total', numerica: true, render: (f) => moneda(f.valor_total) },
              ]}
              filas={informe.grid as Array<FilaInforme & Record<string, unknown>>}
              porPagina={12}
              vacio="Sin artículos activos"
            />
          </div>
        </>
      )}
    </div>
  );
}
