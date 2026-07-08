import { useEffect, useState } from 'react';
import { Eraser, FileDown, RefreshCcw } from 'lucide-react';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { supabase } from '../lib/supabase';
import { useToast } from '../context/ToastContext';
import { DataTable, KpiCard, PageHeader } from '../components/ui';
import { FilaInforme, InformeCierre } from '../lib/types';
import { hoyISO, moneda, numero } from '../utils/format';

const inicioMes = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
};

export default function Dashboard() {
  const { toast } = useToast();
  const [desde, setDesde] = useState(inicioMes());
  const [hasta, setHasta] = useState(hoyISO());
  const [informe, setInforme] = useState<InformeCierre | null>(null);
  const [cargando, setCargando] = useState(false);

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

  useEffect(() => { actualizar(); /* carga inicial del mes en curso */ }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
          <div className="flex gap-2.5">
            <button className="dt-btn dt-btn-primary" onClick={() => actualizar()} disabled={cargando}>
              <RefreshCcw size={16} className={cargando ? 'animate-spin' : ''} /> Actualizar datos
            </button>
            <button className="dt-btn dt-btn-ghost" onClick={limpiarFechas}>
              <Eraser size={16} /> Limpiar fechas
            </button>
            <button className="dt-btn dt-btn-ghost" onClick={generarPDF}>
              <FileDown size={16} /> Generar PDF
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
