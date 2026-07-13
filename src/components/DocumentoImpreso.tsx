import { DocumentoMovimiento } from '../lib/types';
import { fechaMovimiento, moneda, numero } from '../utils/format';

/** Formato de impresión (Entrada/Salida) · reemplaza el reporte físico anterior */
export default function DocumentoImpreso({ doc }: { doc: DocumentoMovimiento }) {
  const esEntrada = doc.naturaleza === 'ENTRADA';
  const ahora = new Date();

  return (
    <div className="doc-impreso">
      <div className="di-logo-wrap">
        <img src="/img/logo.png" alt="Comercializadora T&E S.A.S." className="di-logo" />
      </div>

      <div className="di-encabezado">
        <div>
          <p className="di-empresa">COMERCIALIZADORA T&amp;E S.A.S.</p>
          <p>NIT. 901095472-9</p>
          <p>SEGUIMIENTO {esEntrada ? 'ENTRADA' : 'SALIDA'} FROM</p>
          <p>
            Fecha: {ahora.toLocaleDateString('es-CO')} &nbsp; Hora: {ahora.toLocaleTimeString('es-CO')} &nbsp; Pg. 1 de 1
          </p>
        </div>
        <div className="di-numero">N° Documento: {doc.documento_numero}</div>
      </div>

      <table className="di-tabla">
        <thead>
          <tr>
            <th>Fecha</th>
            <th>Tipo</th>
            <th>Nombre de Producto</th>
            <th>Proveedor</th>
            <th className="di-num">Cant.</th>
            <th className="di-num">V. Unitario</th>
            <th className="di-num">V. Total</th>
            <th>Usuario</th>
          </tr>
        </thead>
        <tbody>
          {(doc.items ?? []).map((it, i) => (
            <tr key={i}>
              {/* fechaMovimiento (no toLocaleDateString): fecha_registro se guarda
                  como medianoche UTC explícita — leerla en hora local del
                  navegador corría el día un día hacia atrás en Colombia/Perú. */}
              <td>{fechaMovimiento(it.fecha_registro)}</td>
              <td>*{it.tipo_movimiento}</td>
              <td>{it.producto_nombre}</td>
              <td>{it.proveedor_nombre ?? '—'}</td>
              <td className="di-num">{numero(it.cantidad)}</td>
              <td className="di-num">{moneda(it.valor_unitario)}</td>
              <td className="di-num">{moneda(it.valor_total)}</td>
              <td>{doc.usuario_nombre ?? '—'}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={4} className="di-totales-label">TOTALES:</td>
            <td className="di-num">{numero(doc.cantidad_total)}</td>
            <td />
            <td className="di-num">{moneda(doc.total)}</td>
            <td />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
