import { useState } from 'react';
import { FileDown, Printer, X } from 'lucide-react';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { supabase } from '../lib/supabase';
import { useToast } from '../context/ToastContext';
import { moneda, numero, fechaSegura } from '../utils/format';

const TIPOS_DOC = [
  { valor: 'FACTURA_VENTA', etiqueta: 'Factura de Venta (Ticket POS)' },
  { valor: 'ENTRADA_ALMACEN', etiqueta: 'Entrada de Almacén' },
  { valor: 'SALIDA_ALMACEN', etiqueta: 'Salida de Almacén' },
  { valor: 'NOTA_DEBITO', etiqueta: 'Nota de Débito' },
];

export default function PrintModal({ abierto, onCerrar }: { abierto: boolean; onCerrar: () => void }) {
  const { toast } = useToast();
  const [tipo, setTipo] = useState('FACTURA_VENTA');
  const [numeroDoc, setNumeroDoc] = useState('');
  const [cargando, setCargando] = useState(false);

  if (!abierto) return null;

  const generar = async () => {
    if (!numeroDoc.trim()) { toast('aviso', 'Ingrese el número de documento'); return; }
    setCargando(true);
    try {
      const { data, error } = await supabase.rpc('rpc_obtener_documento', {
        p_tipo: tipo,
        p_numero: numeroDoc.trim().toUpperCase(),
      });
      if (error) throw error;
      if (!data) { toast('error', 'Documento no encontrado en Supabase'); return; }

      const doc = new jsPDF({ unit: 'mm', format: 'a4' });
      const etiqueta = TIPOS_DOC.find((t) => t.valor === tipo)?.etiqueta ?? tipo;

      // Cabecera corporativa
      doc.setFillColor(30, 41, 59);
      doc.rect(0, 0, 210, 26, 'F');
      doc.setTextColor(255, 255, 255);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(16);
      doc.text('DIEGO TORRES', 14, 12);
      doc.setFontSize(9);
      doc.setFont('helvetica', 'normal');
      doc.text('Sistema de Inventario, POS y CRM Textil', 14, 18);
      doc.setTextColor(79, 70, 229);
      doc.setFontSize(11);
      doc.setFont('helvetica', 'bold');
      doc.text(etiqueta.toUpperCase(), 196, 12, { align: 'right' });
      doc.setTextColor(255, 255, 255);
      doc.setFontSize(10);
      doc.text(`N° ${numeroDoc.trim().toUpperCase()}`, 196, 18, { align: 'right' });

      doc.setTextColor(30, 41, 59);

      if (tipo === 'FACTURA_VENTA') {
        const venta = data.venta;
        const cliente = data.cliente;
        const items: Array<Record<string, unknown>> = data.items ?? [];
        if (!venta) { toast('error', 'Documento no encontrado en Supabase'); return; }

        doc.setFontSize(10);
        doc.setFont('helvetica', 'normal');
        doc.text(`Fecha: ${fechaSegura(venta.fecha)}`, 14, 36);
        doc.text(`Cliente: ${cliente?.nombre ?? 'Público general'}`, 14, 42);
        if (cliente?.documento) doc.text(`Documento: ${cliente.documento}`, 14, 48);
        doc.text(`Método de pago: ${venta.metodo_pago}`, 120, 36);

        autoTable(doc, {
          startY: 56,
          head: [['Descripción', 'Talla', 'Color', 'Cant.', 'V. Unit.', 'Total']],
          body: items.map((i) => [
            String(i.descripcion), String(i.talla), String(i.color),
            numero(Number(i.cantidad)), moneda(Number(i.valor_unitario)), moneda(Number(i.valor_total)),
          ]),
          styles: { fontSize: 9, cellPadding: 2.5 },
          headStyles: { fillColor: [30, 41, 59] },
          columnStyles: { 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' } },
        });
        const finalY = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY;
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(12);
        doc.text(`TOTAL: ${moneda(Number(venta.total))}`, 196, finalY + 10, { align: 'right' });
      } else {
        const mov = data.movimiento;
        const prod = data.producto;
        const prov = data.proveedor;
        if (!mov) { toast('error', 'Documento no encontrado en Supabase'); return; }

        autoTable(doc, {
          startY: 36,
          theme: 'plain',
          styles: { fontSize: 10, cellPadding: 2 },
          body: [
            ['Fecha de registro', fechaSegura(mov.fecha_registro)],
            ['Tipo de movimiento', `${mov.tipo_movimiento} · ${mov.naturaleza}`],
            ['Producto', `${prod?.nombre ?? ''} (${prod?.codigo_barra ?? ''})`],
            ['Talla / Color', `${prod?.talla ?? '—'} / ${prod?.color ?? '—'}`],
            ['Cantidad', numero(Number(mov.cantidad))],
            ['Valor unitario', moneda(Number(mov.valor_unitario))],
            ['Valor total', moneda(Number(mov.valor_total))],
            ['Proveedor', prov?.razon_social ?? '—'],
            ['N° Factura', mov.nro_factura ?? '—'],
            ['N° Orden', mov.nro_orden ?? '—'],
            ['Concepto', mov.concepto ?? '—'],
            ['Stock resultante', numero(Number(mov.stock_resultante))],
          ],
          columnStyles: { 0: { fontStyle: 'bold', cellWidth: 55 } },
        });
      }

      doc.setFontSize(8);
      doc.setTextColor(148, 163, 184);
      doc.text('Documento generado por el sistema Diego Torres · uso interno', 14, 288);
      doc.save(`${tipo}_${numeroDoc.trim().toUpperCase()}.pdf`);
      toast('exito', 'Documento PDF generado con éxito');
      onCerrar();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Error al generar el documento';
      toast('error', msg);
    } finally {
      setCargando(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-end md:items-center justify-center bg-pizarra-900/40 backdrop-blur-[2px] p-4 print:hidden" onClick={onCerrar}>
      <div className="modal-enter dt-card w-full max-w-md p-6" role="dialog" aria-modal="true" aria-label="Impresión de documentos" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-[17px] font-bold text-pizarra-800">
            <Printer size={19} className="text-indigo-600" /> Impresión de documentos
          </h3>
          <button onClick={onCerrar} className="rounded-lg p-1.5 text-pizarra-400 hover:bg-pizarra-100 hover:text-pizarra-700 transition" aria-label="Cerrar">
            <X size={18} />
          </button>
        </div>
        <div className="costura my-4" />
        <label className="dt-label" htmlFor="tipo-doc">Tipo</label>
        <select id="tipo-doc" className="dt-input" value={tipo} onChange={(e) => setTipo(e.target.value)}>
          {TIPOS_DOC.map((t) => <option key={t.valor} value={t.valor}>{t.etiqueta}</option>)}
        </select>
        <label className="dt-label mt-4" htmlFor="nro-doc">N° Documento</label>
        <input
          id="nro-doc"
          className="dt-input font-mono"
          placeholder={tipo === 'FACTURA_VENTA' ? 'TCK000000001' : 'ENT000000001 / SAL000000001'}
          value={numeroDoc}
          onChange={(e) => setNumeroDoc(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && generar()}
        />
        <button className="dt-btn dt-btn-primary mt-5 w-full" onClick={generar} disabled={cargando}>
          <FileDown size={17} />
          {cargando ? 'Consultando Supabase…' : 'Aceptar'}
        </button>
      </div>
    </div>
  );
}
