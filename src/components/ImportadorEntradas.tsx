import { useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { CheckCircle2, Download, FileSpreadsheet, Upload, X, XCircle } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useToast } from '../context/ToastContext';
import { Familia, GENEROS, Producto, Proveedor, TIPOS_ENTRADA } from '../lib/types';
import { hoyISO, limitesMesActual } from '../utils/format';

const COLUMNAS_REQUERIDAS = ['familia', 'nombre', 'genero', 'color', 'talla', 'cantidad', 'valor', 'proveedor'] as const;

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
  cantidad: number;
  valor: number;
  id_proveedor: string;
  tipoMovimiento: string;
  fecha: string;
  factura: string;
  orden: string;
  concepto: string;
  claveProducto: string;
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

function normalizarTexto(v: string): string {
  return v.trim().toUpperCase();
}

function descargarPlantilla() {
  const encabezado = 'familia,nombre,genero,color,talla,cantidad,valor,proveedor,tipo_movimiento,fecha,factura,orden,concepto\n';
  const ejemplo = 'BATA,HOMBRE,DRIL AZUL,M,BATA,50,35.90,TEXTILES DEL NORTE S.A.C.,1000,,F001-000123,OC-2026-001,Reposición de temporada\n';
  const blob = new Blob([encabezado + ejemplo], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'plantilla_entradas_diego_torres.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function ImportadorEntradas({
  deshabilitado, onCompletado,
}: {
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
      // Catálogos de referencia siempre frescos al momento de analizar el archivo
      const [{ data: fam, error: eFam }, { data: prov, error: eProv }] = await Promise.all([
        supabase.from('familias').select('*'),
        supabase.from('terceros').select('*'),
      ]);
      if (eFam || eProv) { toast('error', 'No se pudo cargar familias/proveedores para validar el archivo'); return; }
      const familias = (fam as Familia[]) ?? [];
      const proveedores = (prov as Proveedor[]) ?? [];

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

      const { min: fechaMin, max: fechaMax } = limitesMesActual();
      const buenas: FilaValida[] = [];
      const malas: FilaInvalida[] = [];

      filas.forEach((filaCruda, idx) => {
        const numFila = idx + 2;
        const porClave: Record<string, string> = {};
        for (const [k, v] of Object.entries(filaCruda)) {
          porClave[normalizarClave(k)] = String(v ?? '').trim();
        }

        const nombre = porClave['nombre'] ?? '';
        const generoCrudo = (porClave['genero'] ?? '').toUpperCase();
        const color = porClave['color'] ?? '';
        const talla = porClave['talla'] ?? '';
        const familiaTexto = porClave['familia'] ?? '';
        const cantidadTexto = porClave['cantidad'] ?? '';
        const valorTexto = porClave['valor'] ?? '';
        const proveedorTexto = porClave['proveedor'] ?? '';
        const tipoMovTexto = porClave['tipo_movimiento'] || '1000';
        const facturaTexto = porClave['factura'] ?? '';
        const ordenTexto = porClave['orden'] ?? '';
        const conceptoTexto = porClave['concepto'] ?? '';
        let fechaTexto = porClave['fecha'] || hoyISO();

        if (!nombre) { malas.push({ fila: numFila, motivo: 'Falta el nombre' }); return; }
        if (!generoCrudo || !GENEROS.includes(generoCrudo)) {
          malas.push({ fila: numFila, motivo: `Género inválido "${generoCrudo}" (debe ser: ${GENEROS.join(', ')})` });
          return;
        }
        if (!color) { malas.push({ fila: numFila, motivo: 'Falta el color' }); return; }
        if (!talla) { malas.push({ fila: numFila, motivo: 'Falta la talla' }); return; }
        if (!familiaTexto) { malas.push({ fila: numFila, motivo: 'Falta la familia' }); return; }

        const fam = familias.find((f) => f.codigo.toLowerCase() === familiaTexto.toLowerCase())
          ?? familias.find((f) => f.nombre.toLowerCase() === familiaTexto.toLowerCase());
        if (!fam) {
          malas.push({ fila: numFila, motivo: `Familia "${familiaTexto}" no existe (use el código o nombre exacto)` });
          return;
        }

        const cantidad = parseFloat(cantidadTexto.replace(',', '.'));
        if (!cantidadTexto || isNaN(cantidad) || cantidad <= 0) {
          malas.push({ fila: numFila, motivo: `Cantidad inválida "${cantidadTexto}" (debe ser un número mayor a 0)` });
          return;
        }

        const valor = parseFloat(valorTexto.replace(',', '.'));
        if (!valorTexto || isNaN(valor) || valor < 0) {
          malas.push({ fila: numFila, motivo: `Valor unitario inválido "${valorTexto}" (debe ser un número mayor o igual a 0)` });
          return;
        }

        if (!proveedorTexto) { malas.push({ fila: numFila, motivo: 'Falta el proveedor' }); return; }
        const prov2 = proveedores.find((p) => p.nit_documento.toLowerCase() === proveedorTexto.toLowerCase())
          ?? proveedores.find((p) => p.razon_social.toLowerCase() === proveedorTexto.toLowerCase());
        if (!prov2) {
          malas.push({ fila: numFila, motivo: `Proveedor "${proveedorTexto}" no existe (use el NIT/documento o la razón social exacta)` });
          return;
        }

        const tipoMov = tipoMovTexto.trim();
        if (!TIPOS_ENTRADA.some((t) => t.codigo === tipoMov)) {
          malas.push({ fila: numFila, motivo: `Tipo de movimiento "${tipoMov}" no autorizado (use: ${TIPOS_ENTRADA.map((t) => t.codigo).join(', ')})` });
          return;
        }

        // Normaliza fecha tipo Excel (número serie) o texto a YYYY-MM-DD
        if (/^\d+(\.\d+)?$/.test(fechaTexto)) {
          const serie = Number(fechaTexto);
          const fechaExcel = new Date(Math.round((serie - 25569) * 86400 * 1000));
          fechaTexto = fechaExcel.toISOString().slice(0, 10);
        } else if (fechaTexto.includes('/')) {
          const [d, m, y] = fechaTexto.split('/');
          if (d && m && y) fechaTexto = `${y.length === 2 ? '20' + y : y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
        }
        if (fechaTexto < fechaMin || fechaTexto > fechaMax) {
          malas.push({ fila: numFila, motivo: `Fecha "${fechaTexto}" fuera del mes actual (debe estar entre ${fechaMin} y ${fechaMax})` });
          return;
        }

        buenas.push({
          fila: numFila, nombre, genero: generoCrudo, color, talla, id_familia: fam.id_familia,
          cantidad, valor, id_proveedor: prov2.id_proveedor, tipoMovimiento: tipoMov, fecha: fechaTexto,
          factura: facturaTexto, orden: ordenTexto, concepto: conceptoTexto,
          claveProducto: `${fam.id_familia}|${normalizarTexto(nombre)}|${generoCrudo}|${normalizarTexto(color)}|${normalizarTexto(talla)}`,
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

    // Catálogo de productos existentes, para no crear duplicados. Si esta
    // consulta falla, abortamos: seguir con una lista vacía haría que el
    // importador cree artículos duplicados para productos que ya existen.
    const { data: prodData, error: errorProductos } = await supabase.from('productos').select('*').eq('activo', true);
    if (errorProductos) {
      toast('error', 'No se pudo leer el catálogo actual. Se canceló la importación para evitar artículos duplicados.');
      setImportando(false);
      setProgreso({ hecho: 0, total: 0 });
      return;
    }
    const productos = (prodData as Producto[]) ?? [];
    const productoPorClave = new Map<string, string>();
    for (const p of productos) {
      const clave = `${p.id_familia}|${normalizarTexto(p.nombre)}|${normalizarTexto(p.genero)}|${normalizarTexto(p.color)}|${normalizarTexto(p.talla)}`;
      productoPorClave.set(clave, p.id_producto);
    }

    for (const fila of validas) {
      try {
        let idProducto = productoPorClave.get(fila.claveProducto);

        if (!idProducto) {
          const { data: creado, error: errorCrear } = await supabase.rpc('rpc_crear_articulo', {
            p_id_familia: fila.id_familia,
            p_nombre: fila.nombre,
            p_genero: fila.genero,
            p_color: fila.color,
            p_talla: fila.talla,
          });
          if (errorCrear) {
            res.push({ fila: fila.fila, ok: false, detalle: `No se pudo crear el artículo: ${errorCrear.message}` });
            setProgreso((p) => ({ ...p, hecho: p.hecho + 1 }));
            continue;
          }
          idProducto = creado.id_producto as string;
          productoPorClave.set(fila.claveProducto, idProducto);
        }

        const { data, error } = await supabase.rpc('rpc_registrar_entrada', {
          p_producto_id: idProducto,
          p_tipo_movimiento: fila.tipoMovimiento,
          p_cantidad: fila.cantidad,
          p_valor_unitario: fila.valor,
          p_proveedor_id: fila.id_proveedor,
          p_nro_factura: fila.factura || null,
          p_nro_orden: fila.orden || null,
          p_concepto: fila.concepto || null,
          p_fecha: fila.fecha,
        });
        if (error) {
          const msg = error.message.includes('PERIODO_CERRADO') ? error.message.replace(/^.*?:/, '').trim() : error.message;
          res.push({ fila: fila.fila, ok: false, detalle: msg });
        } else {
          res.push({ fila: fila.fila, ok: true, detalle: `${data.consecutivo} · stock ${data.nuevo_stock}` });
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
      toast('exito', `Carga masiva completa: ${creados} entrada(s) registrada(s)`);
    } else {
      toast('aviso', `Carga masiva: ${creados} registrada(s), ${fallidos} con error`);
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
      <div className="modal-enter dt-card w-full max-w-2xl p-6" role="dialog" aria-modal="true" aria-label="Carga masiva de entradas" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-[17px] font-bold text-pizarra-800">
            <FileSpreadsheet size={19} className="text-indigo-600" /> Carga masiva de entradas
          </h3>
          <button onClick={cerrar} className="rounded-lg p-1.5 text-pizarra-400 hover:bg-pizarra-100 hover:text-pizarra-700 transition" aria-label="Cerrar">
            <X size={18} />
          </button>
        </div>

        <p className="mt-2 text-[13px] leading-relaxed text-pizarra-500">
          Archivo <strong>.xlsx</strong> o <strong>.csv</strong> con las columnas exactas:{' '}
          <code className="rounded bg-pizarra-100 px-1.5 py-0.5 font-mono text-[12px]">
            familia, nombre, genero, color, talla, cantidad, valor, proveedor
          </code>
          {' '}(opcionales: tipo_movimiento, fecha, factura, orden, concepto).
          Si el artículo no existe en el catálogo se crea automáticamente; si ya existe, solo se le suma el stock.
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
                  Fila {r.fila}: {r.ok ? `registrada · ${r.detalle}` : r.detalle}
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
            <Upload size={16} /> {importando ? 'Importando…' : `Importar ${validas.length || ''} entrada(s)`}
          </button>
        </div>
      </div>
    </div>
  );
}
