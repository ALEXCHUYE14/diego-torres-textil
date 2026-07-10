import { useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { CheckCircle2, Download, FileSpreadsheet, Upload, X, XCircle } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useToast } from '../context/ToastContext';
import { Familia } from '../lib/types';

const COLUMNAS_REQUERIDAS = ['codigo', 'familia', 'nombre'] as const;

interface FilaCruda {
  [clave: string]: unknown;
}

interface FilaValida {
  fila: number;
  codigo: string;
  nombre: string;
  genero: string;
  color: string;
  talla: string;
  id_familia: string;
  saldoInicial: number;
  valorInicial: number;
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

function normalizarClave(clave: string): string {
  return clave.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function descargarPlantilla() {
  const encabezado = 'codigo,familia,nombre,genero,color,talla,saldo_inicial,valor_inicial\n';
  const ejemplo1 = 'BAT-001,BATA,BATA CLINICA,UNISEX,BLANCO,M,25,38500\n';
  const ejemplo2 = 'EXT-CHAF-01,BIOSEGURIDAD,EXTINTOR MARCA CHAFLUE,,,,3,145000\n';
  // Ejemplo con existencia 0: deja explícito que un artículo sin stock inicial
  // (se codifica ahora, se recibe después) es un caso válido y soportado.
  const ejemplo3 = 'PAT-099,PANTALON,PANTALON DRIL AZUL,HOMBRE,AZUL,32,0,42000\n';
  const blob = new Blob([encabezado + ejemplo1 + ejemplo2 + ejemplo3], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'plantilla_catalogo_diego_torres.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function ImportadorCatalogo({
  familias, deshabilitado, onCompletado,
}: {
  familias: Familia[];
  deshabilitado?: boolean;
  onCompletado?: () => void;
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

      const clavesHoja = Object.keys(filas[0]).map(normalizarClave);
      const faltantes = COLUMNAS_REQUERIDAS.filter((c) => !clavesHoja.includes(c));
      if (faltantes.length > 0) {
        toast('error', `Faltan columnas obligatorias: ${faltantes.join(', ')}`);
        return;
      }

      const buenas: FilaValida[] = [];
      const malas: FilaInvalida[] = [];
      const codigosVistos = new Set<string>();

      filas.forEach((filaCruda, idx) => {
        const numFila = idx + 2;
        const porClave: Record<string, string> = {};
        for (const [k, v] of Object.entries(filaCruda)) {
          porClave[normalizarClave(k)] = String(v ?? '').trim();
        }

        const codigo = porClave['codigo']?.toUpperCase() ?? '';
        const nombre = porClave['nombre'] ?? '';
        const genero = (porClave['genero'] ?? '').toUpperCase();
        const color = (porClave['color'] ?? '').toUpperCase();
        const talla = (porClave['talla'] ?? '').toUpperCase();
        const familiaTexto = porClave['familia'] ?? '';
        const saldoTexto = porClave['saldo_inicial'] || '0';
        const valorTexto = porClave['valor_inicial'] || '0';

        if (!codigo) { malas.push({ fila: numFila, motivo: 'Falta el código del producto' }); return; }
        if (codigosVistos.has(codigo)) { malas.push({ fila: numFila, motivo: `Código "${codigo}" repetido dentro del mismo archivo` }); return; }
        if (!nombre) { malas.push({ fila: numFila, motivo: 'Falta el nombre' }); return; }
        if (!familiaTexto) { malas.push({ fila: numFila, motivo: 'Falta la familia' }); return; }

        const fam = familias.find((f) => f.codigo.toLowerCase() === familiaTexto.toLowerCase())
          ?? familias.find((f) => f.nombre.toLowerCase() === familiaTexto.toLowerCase());
        if (!fam) {
          malas.push({ fila: numFila, motivo: `Familia "${familiaTexto}" no existe (use el código o nombre exacto)` });
          return;
        }

        const saldoInicial = parseFloat(saldoTexto.replace(',', '.'));
        if (isNaN(saldoInicial) || saldoInicial < 0) {
          malas.push({ fila: numFila, motivo: `Saldo inicial inválido "${saldoTexto}"` });
          return;
        }
        const valorInicial = parseFloat(valorTexto.replace(',', '.'));
        if (isNaN(valorInicial) || valorInicial < 0) {
          malas.push({ fila: numFila, motivo: `Valor inicial inválido "${valorTexto}"` });
          return;
        }

        codigosVistos.add(codigo);
        buenas.push({
          fila: numFila, codigo, nombre, genero, color, talla,
          id_familia: fam.id_familia, saldoInicial, valorInicial,
        });
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
        const { data, error } = await supabase.rpc('rpc_importar_articulo_inicial', {
          p_codigo_barra: fila.codigo,
          p_nombre: fila.nombre,
          p_id_familia: fila.id_familia,
          p_genero: fila.genero || null,
          p_color: fila.color || null,
          p_talla: fila.talla || null,
          p_saldo_inicial: fila.saldoInicial,
          p_valor_inicial: fila.valorInicial,
        });
        if (error) {
          const msg = error.code === '23505' ? `El código "${fila.codigo}" ya existe en el catálogo` : error.message;
          res.push({ fila: fila.fila, ok: false, detalle: msg });
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
    if (creados > 0) onCompletado?.();
    if (fallidos === 0) {
      toast('exito', `Carga masiva completa: ${creados} artículo(s) cargado(s) con su saldo inicial`);
    } else {
      toast('aviso', `Carga masiva: ${creados} cargado(s), ${fallidos} con error`);
    }
  };

  if (!abierto) {
    return (
      <button type="button" className="dt-btn dt-btn-ghost" disabled={deshabilitado} onClick={() => setAbierto(true)}>
        <FileSpreadsheet size={16} /> Carga masiva de catálogo
      </button>
    );
  }

  return (
    <div className="fixed inset-0 z-[75] flex items-end md:items-center justify-center bg-pizarra-900/40 backdrop-blur-[2px] p-4 print:hidden" onClick={cerrar}>
      <div className="modal-enter dt-card w-full max-w-2xl p-6" role="dialog" aria-modal="true" aria-label="Carga masiva de catálogo" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-[17px] font-bold text-pizarra-800">
            <FileSpreadsheet size={19} className="text-indigo-600" /> Carga masiva de catálogo
          </h3>
          <button onClick={cerrar} className="rounded-lg p-1.5 text-pizarra-400 hover:bg-pizarra-100 hover:text-pizarra-700 transition" aria-label="Cerrar">
            <X size={18} />
          </button>
        </div>

        <p className="mt-2 text-[13px] leading-relaxed text-pizarra-500">
          Para cargar el inventario base del sistema. Columnas exactas:{' '}
          <code className="rounded bg-pizarra-100 px-1.5 py-0.5 font-mono text-[12px]">codigo, familia, nombre</code>
          {' '}(obligatorias); <code className="rounded bg-pizarra-100 px-1.5 py-0.5 font-mono text-[12px]">genero, color, talla, saldo_inicial, valor_inicial</code>{' '}
          son opcionales. El código lo define usted (no se genera automáticamente).{' '}
          <strong>Si deja <code className="rounded bg-pizarra-100 px-1 py-0.5 font-mono text-[11.5px]">saldo_inicial</code> en 0 o en blanco,
          el artículo se crea igual, solo que sin existencias</strong> (útil para codificar productos que aún no ha recibido).
          Esto es solo para la carga inicial del catálogo — los movimientos del día a día se registran manualmente desde Entradas y Salidas.
        </p>

        <button type="button" onClick={descargarPlantilla} className="mt-3 inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-indigo-600 hover:text-indigo-700">
          <Download size={14} /> Descargar plantilla de ejemplo (.csv)
        </button>

        <div className="costura my-4" />

        <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-pizarra-300 px-4 py-8 text-center transition hover:border-indigo-400 hover:bg-indigo-600/[0.03]">
          <Upload size={22} className="text-pizarra-400" />
          <span className="text-[13.5px] font-medium text-pizarra-600">{nombreArchivo || 'Seleccione un archivo .xlsx o .csv'}</span>
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
                  <li key={f.fila} className="px-3 py-2 text-[12.5px] text-red-600">Fila {f.fila}: {f.motivo}</li>
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
                  Fila {r.fila}: {r.ok ? `cargado · ${r.detalle}` : r.detalle}
                </li>
              ))}
            </ul>
          </div>
        )}

        {importando && (
          <p className="mt-3 text-center text-[13px] text-pizarra-500">Importando {progreso.hecho}/{progreso.total}…</p>
        )}

        <div className="mt-5 flex justify-end gap-3">
          <button type="button" className="dt-btn dt-btn-ghost" onClick={cerrar}>Cerrar</button>
          <button type="button" className="dt-btn dt-btn-primary" disabled={validas.length === 0 || importando || deshabilitado} onClick={importar}>
            <Upload size={16} /> {importando ? 'Importando…' : `Importar ${validas.length || ''} artículo(s)`}
          </button>
        </div>
      </div>
    </div>
  );
}
