import { useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { CheckCircle2, Download, FileSpreadsheet, Upload, X, XCircle } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useToast } from '../context/ToastContext';
import { Familia, GENEROS } from '../lib/types';

const COLUMNAS_REQUERIDAS = ['nombre', 'genero', 'color', 'talla', 'familia'] as const;

interface FilaCruda {
  [clave: string]: unknown;
}

interface FilaValida {
  fila: number;
  nombre: string;
  genero: string;
  color: string;
  talla: string;
  id_familia: string;
  familiaTexto: string;
}

interface FilaInvalida {
  fila: number;
  motivo: string;
}

interface ResultadoFila {
  fila: number;
  ok: boolean;
  detalle: string;
}

/** Normaliza encabezados: minúsculas, sin espacios ni acentos comunes. */
function normalizarClave(clave: string): string {
  return clave
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

function descargarPlantilla() {
  const encabezado = 'nombre,genero,color,talla,familia\n';
  const ejemplo = 'BATA,HOMBRE,DRIL AZUL,M,BATA\n';
  const blob = new Blob([encabezado + ejemplo], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'plantilla_articulos_diego_torres.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function ImportadorArticulos({
  familias, deshabilitado, onCompletado,
}: {
  familias: Familia[];
  deshabilitado?: boolean;
  onCompletado: () => void;
}) {
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);

  const [abierto, setAbierto] = useState(false);
  const [nombreArchivo, setNombreArchivo] = useState('');
  const [analizando, setAnalizando] = useState(false);
  const [validas, setValidas] = useState<FilaValida[]>([]);
  const [invalidas, setInvalidas] = useState<FilaInvalida[]>([]);
  const [importando, setImportando] = useState(false);
  const [progreso, setProgreso] = useState({ hecho: 0, total: 0 });
  const [resultado, setResultado] = useState<ResultadoFila[] | null>(null);

  const reiniciar = () => {
    setNombreArchivo(''); setValidas([]); setInvalidas([]); setResultado(null);
    setProgreso({ hecho: 0, total: 0 });
    if (inputRef.current) inputRef.current.value = '';
  };

  const cerrar = () => {
    setAbierto(false);
    reiniciar();
  };

  const resolverFamilia = (texto: string): Familia | null => {
    const t = texto.trim().toLowerCase();
    if (!t) return null;
    return (
      familias.find((f) => f.codigo.toLowerCase() === t) ??
      familias.find((f) => f.nombre.toLowerCase() === t) ??
      null
    );
  };

  const analizarArchivo = async (file: File) => {
    setAnalizando(true);
    reiniciar();
    setNombreArchivo(file.name);
    try {
      const buffer = await file.arrayBuffer();
      const libro = XLSX.read(buffer, { type: 'array' });
      const hoja = libro.Sheets[libro.SheetNames[0]];
      if (!hoja) { toast('error', 'El archivo no tiene hojas legibles'); return; }

      const filas = XLSX.utils.sheet_to_json<FilaCruda>(hoja, { defval: '' });
      if (filas.length === 0) { toast('error', 'El archivo está vacío'); return; }

      // Verifica que existan las columnas requeridas (por nombre normalizado)
      const clavesHoja = Object.keys(filas[0]).map(normalizarClave);
      const faltantes = COLUMNAS_REQUERIDAS.filter((c) => !clavesHoja.includes(c));
      if (faltantes.length > 0) {
        toast('error', `Faltan columnas obligatorias: ${faltantes.join(', ')}`);
        return;
      }

      const buenas: FilaValida[] = [];
      const malas: FilaInvalida[] = [];

      filas.forEach((filaCruda, idx) => {
        const numFila = idx + 2; // +1 encabezado, +1 base 1
        const porClave: Record<string, string> = {};
        for (const [k, v] of Object.entries(filaCruda)) {
          porClave[normalizarClave(k)] = String(v ?? '').trim();
        }

        const nombre = porClave['nombre'] ?? '';
        const generoCrudo = (porClave['genero'] ?? '').toUpperCase();
        const color = porClave['color'] ?? '';
        const talla = porClave['talla'] ?? '';
        const familiaTexto = porClave['familia'] ?? '';

        if (!nombre) { malas.push({ fila: numFila, motivo: 'Falta el nombre' }); return; }
        if (!generoCrudo || !GENEROS.includes(generoCrudo)) {
          malas.push({ fila: numFila, motivo: `Género inválido "${generoCrudo}" (debe ser: ${GENEROS.join(', ')})` });
          return;
        }
        if (!color) { malas.push({ fila: numFila, motivo: 'Falta el color' }); return; }
        if (!talla) { malas.push({ fila: numFila, motivo: 'Falta la talla' }); return; }
        if (!familiaTexto) { malas.push({ fila: numFila, motivo: 'Falta la familia' }); return; }

        const fam = resolverFamilia(familiaTexto);
        if (!fam) {
          malas.push({ fila: numFila, motivo: `Familia "${familiaTexto}" no existe (use el código o nombre exacto)` });
          return;
        }

        buenas.push({ fila: numFila, nombre, genero: generoCrudo, color, talla, id_familia: fam.id_familia, familiaTexto });
      });

      setValidas(buenas);
      setInvalidas(malas);
      if (buenas.length === 0) {
        toast('aviso', 'Ninguna fila pasó la validación. Revise el detalle de errores.');
      }
    } catch {
      toast('error', 'No se pudo leer el archivo. Verifique que sea un .xlsx o .csv válido.');
    } finally {
      setAnalizando(false);
    }
  };

  const importar = async () => {
    if (validas.length === 0) return;
    setImportando(true);
    setProgreso({ hecho: 0, total: validas.length });
    const res: ResultadoFila[] = [];

    for (const fila of validas) {
      try {
        const { data, error } = await supabase.rpc('rpc_crear_articulo', {
          p_id_familia: fila.id_familia,
          p_nombre: fila.nombre,
          p_genero: fila.genero,
          p_color: fila.color,
          p_talla: fila.talla,
        });
        if (error) {
          res.push({ fila: fila.fila, ok: false, detalle: error.message });
        } else {
          res.push({ fila: fila.fila, ok: true, detalle: data.codigo_barra });
        }
      } catch {
        res.push({ fila: fila.fila, ok: false, detalle: 'Error de red' });
      }
      setProgreso((p) => ({ ...p, hecho: p.hecho + 1 }));
    }

    setResultado(res);
    setImportando(false);
    const creados = res.filter((r) => r.ok).length;
    const fallidos = res.length - creados;
    if (creados > 0) onCompletado();
    if (fallidos === 0) {
      toast('exito', `Carga masiva completa: ${creados} artículo(s) creado(s)`);
    } else {
      toast('aviso', `Carga masiva: ${creados} creado(s), ${fallidos} con error`);
    }
  };

  if (!abierto) {
    return (
      <button
        type="button"
        className="dt-btn dt-btn-ghost"
        disabled={deshabilitado}
        onClick={() => setAbierto(true)}
      >
        <FileSpreadsheet size={16} /> Carga masiva
      </button>
    );
  }

  return (
    <div className="fixed inset-0 z-[75] flex items-end md:items-center justify-center bg-pizarra-900/40 backdrop-blur-[2px] p-4 print:hidden" onClick={cerrar}>
      <div className="modal-enter dt-card w-full max-w-2xl p-6" role="dialog" aria-modal="true" aria-label="Carga masiva de artículos" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-[17px] font-bold text-pizarra-800">
            <FileSpreadsheet size={19} className="text-indigo-600" /> Carga masiva de artículos
          </h3>
          <button onClick={cerrar} className="rounded-lg p-1.5 text-pizarra-400 hover:bg-pizarra-100 hover:text-pizarra-700 transition" aria-label="Cerrar">
            <X size={18} />
          </button>
        </div>

        <p className="mt-2 text-[13px] leading-relaxed text-pizarra-500">
          Archivo <strong>.xlsx</strong> o <strong>.csv</strong> con las columnas exactas:{' '}
          <code className="rounded bg-pizarra-100 px-1.5 py-0.5 font-mono text-[12px]">nombre, genero, color, talla, familia</code>.
          El valor unitario y el precio de venta no se cargan aquí: se definen luego desde Entradas.
        </p>

        <button type="button" onClick={descargarPlantilla} className="mt-3 inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-indigo-600 hover:text-indigo-700">
          <Download size={14} /> Descargar plantilla de ejemplo (.csv)
        </button>

        <div className="costura my-4" />

        <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-pizarra-300 px-4 py-8 text-center transition hover:border-indigo-400 hover:bg-indigo-600/[0.03]">
          <Upload size={22} className="text-pizarra-400" />
          <span className="text-[13.5px] font-medium text-pizarra-600">
            {nombreArchivo || 'Seleccione un archivo .xlsx o .csv'}
          </span>
          <input
            ref={inputRef}
            type="file"
            accept=".xlsx,.xls,.csv,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) analizarArchivo(f); }}
          />
        </label>

        {analizando && <p className="mt-3 text-center text-[13px] text-pizarra-500">Analizando archivo…</p>}

        {(validas.length > 0 || invalidas.length > 0) && !analizando && (
          <div className="mt-4 max-h-64 overflow-auto rounded-lg border border-pizarra-200">
            <div className="sticky top-0 flex items-center justify-between gap-4 border-b border-pizarra-200 bg-pizarra-50 px-3 py-2 text-[12.5px] font-semibold text-pizarra-600">
              <span className="flex items-center gap-1.5 text-emerald-700"><CheckCircle2 size={14} /> {validas.length} válidas</span>
              <span className="flex items-center gap-1.5 text-red-600"><XCircle size={14} /> {invalidas.length} con error</span>
            </div>
            {invalidas.length > 0 && (
              <ul className="divide-y divide-pizarra-100">
                {invalidas.map((f) => (
                  <li key={f.fila} className="px-3 py-2 text-[12.5px] text-red-600">
                    Fila {f.fila}: {f.motivo}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {resultado && (
          <div className="mt-4 max-h-48 overflow-auto rounded-lg border border-pizarra-200">
            <ul className="divide-y divide-pizarra-100">
              {resultado.map((r) => (
                <li key={r.fila} className={`px-3 py-2 text-[12.5px] ${r.ok ? 'text-emerald-700' : 'text-red-600'}`}>
                  Fila {r.fila}: {r.ok ? `creado · ${r.detalle}` : r.detalle}
                </li>
              ))}
            </ul>
          </div>
        )}

        {importando && (
          <p className="mt-3 text-center text-[13px] text-pizarra-500">
            Importando {progreso.hecho}/{progreso.total}…
          </p>
        )}

        <div className="mt-5 flex justify-end gap-3">
          <button type="button" className="dt-btn dt-btn-ghost" onClick={cerrar}>Cerrar</button>
          <button
            type="button"
            className="dt-btn dt-btn-primary"
            disabled={validas.length === 0 || importando || deshabilitado}
            onClick={importar}
          >
            <Upload size={16} /> {importando ? 'Importando…' : `Importar ${validas.length || ''} artículo(s)`}
          </button>
        </div>
      </div>
    </div>
  );
}
