import { useEffect, useState } from 'react';
import { FileDown, Printer, X } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useToast } from '../context/ToastContext';
import { DocumentoMovimiento } from '../lib/types';
import DocumentoImpreso from './DocumentoImpreso';

const TIPOS_DOC = [
  { valor: 'ENTRADA_ALMACEN', etiqueta: 'Entrada de Almacén' },
  { valor: 'SALIDA_ALMACEN', etiqueta: 'Salida de Almacén' },
];

export default function PrintModal({ abierto, onCerrar }: { abierto: boolean; onCerrar: () => void }) {
  const { toast } = useToast();
  const [tipo, setTipo] = useState('ENTRADA_ALMACEN');
  const [numeroDoc, setNumeroDoc] = useState('');
  const [cargando, setCargando] = useState(false);
  const [documento, setDocumento] = useState<DocumentoMovimiento | null>(null);

  // Un setTimeout de tiempo fijo es una apuesta: un documento con muchas
  // líneas (o un dispositivo lento) podría no haber terminado de pintarse
  // en el DOM cuando se cumplen los milisegundos, imprimiendo en blanco o
  // incompleto. Con "doble rAF" se espera a que el navegador confirme que
  // ya pintó el frame donde entró `documento` antes de invocar la
  // impresión — funciona sin importar cuánto tarde el layout.
  useEffect(() => {
    if (!documento) return;
    let id2 = 0;
    const id1 = requestAnimationFrame(() => {
      id2 = requestAnimationFrame(() => window.print());
    });
    return () => { cancelAnimationFrame(id1); cancelAnimationFrame(id2); };
  }, [documento]);

  if (!abierto) return null;

  const cerrar = () => {
    setDocumento(null);
    setNumeroDoc('');
    onCerrar();
  };

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

      setDocumento(data as DocumentoMovimiento);
      toast('exito', 'Documento listo para imprimir');
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Error al generar el documento';
      toast('error', msg);
    } finally {
      setCargando(false);
    }
  };

  return (
    <>
      <div className="fixed inset-0 z-[70] flex items-end md:items-center justify-center bg-pizarra-900/40 backdrop-blur-[2px] p-4 print:hidden" onClick={cerrar}>
        <div className="modal-enter dt-card w-full max-w-md p-6" role="dialog" aria-modal="true" aria-label="Impresión de documentos" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-[17px] font-bold text-pizarra-800">
              <Printer size={19} className="text-indigo-600" /> Impresión de documentos
            </h3>
            <button onClick={cerrar} className="rounded-lg p-1.5 text-pizarra-400 hover:bg-pizarra-100 hover:text-pizarra-700 transition" aria-label="Cerrar">
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
            placeholder="ENT000000001 / SAL000000001"
            value={numeroDoc}
            onChange={(e) => setNumeroDoc(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && generar()}
          />
          <button className="dt-btn dt-btn-primary mt-5 w-full" onClick={generar} disabled={cargando}>
            <FileDown size={17} />
            {cargando ? 'Consultando Supabase…' : 'Buscar e imprimir'}
          </button>
        </div>
      </div>

      {documento && <DocumentoImpreso doc={documento} />}
    </>
  );
}
