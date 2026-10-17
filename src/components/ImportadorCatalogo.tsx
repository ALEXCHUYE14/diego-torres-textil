import { useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { CheckCircle2, Download, FileSpreadsheet, Upload, X, XCircle } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useToast } from '../context/ToastContext';
import { Familia } from '../lib/types';
import { normalizarTexto } from '../utils/busqueda';
import { hoyISO, limitesFechaMovimiento } from '../utils/format';

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

// Raíz de un nombre de familia para comparar sin importar singular/plural:
// "MATERIA PRIMA" y "MATERIAS PRIMAS", "CHAQUETA" y "CHAQUETAS",
// "PANTALON" y "PANTALONES" dan la misma raíz. Se aplica igual a los dos
// lados de la comparación, así que no importa que la raíz no sea una
// palabra real (ej. "GRIS" → "GRI").
function raizFamilia(texto: string): string {
  return normalizarTexto(texto)
    .split(' ')
    .map((p) => {
      if (p.length > 4 && p.endsWith('ES') && !'AEIOU'.includes(p[p.length - 3])) return p.slice(0, -2);
      if (p.length > 3 && p.endsWith('S')) return p.slice(0, -1);
      return p;
    })
    .join(' ');
}

/**
 * Busca la familia escrita en el archivo, de la coincidencia más estricta a
 * la más tolerante: código exacto → nombre exacto → nombre sin tildes ni
 * espacios de más → singular/plural. En los pasos tolerantes solo se acepta
 * si hay UNA sola familia candidata; si hay varias se rechaza la fila en vez
 * de adivinar (cargar un artículo en la familia equivocada es peor que
 * pedir que se corrija el archivo).
 */
function buscarFamilia(familias: Familia[], texto: string): { familia: Familia } | { error: string } {
  const t = texto.trim().toLowerCase();
  const exacta = familias.find((f) => f.codigo.toLowerCase() === t) ?? familias.find((f) => f.nombre.toLowerCase() === t);
  if (exacta) return { familia: exacta };

  for (const clave of [normalizarTexto, raizFamilia]) {
    const buscada = clave(texto);
    const candidatas = familias.filter((f) => clave(f.nombre) === buscada);
    if (candidatas.length === 1) return { familia: candidatas[0] };
    if (candidatas.length > 1) {
      return { error: `Familia "${texto}" es ambigua: coincide con ${candidatas.map((f) => `"${f.nombre}" (${f.codigo})`).join(', ')}. Escriba el código de la familia.` };
    }
  }

  const disponibles = [...familias].sort((a, b) => a.nombre.localeCompare(b.nombre)).map((f) => f.nombre);
  const lista = disponibles.length > 25 ? `${disponibles.slice(0, 25).join(', ')}…` : disponibles.join(', ');
  return { error: `Familia "${texto}" no existe. Familias disponibles: ${lista || '(ninguna — créelas en Catálogos)'}` };
}

// Misma identidad que el índice único uq_productos_atributos_activos del
// servidor: familia + nombre + género + color + talla (vacío = NULL).
const claveArticulo = (idFamilia: string, nombre: string, genero: string | null, color: string | null, talla: string | null) =>
  [idFamilia, nombre, genero ?? '', color ?? '', talla ?? ''].map((v) => v.trim().toUpperCase()).join('|');

interface ProductoExistente {
  codigo_barra: string;
  nombre: string;
  genero: string | null;
  color: string | null;
  talla: string | null;
  id_familia: string;
  activo: boolean;
}

async function consultarEnLotes(columna: 'codigo_barra' | 'nombre', valores: string[]): Promise<ProductoExistente[]> {
  const unicos = [...new Set(valores)];
  const resultado: ProductoExistente[] = [];
  // Lotes de 100: la lista viaja en la URL de la consulta y no debe crecer sin límite.
  for (let i = 0; i < unicos.length; i += 100) {
    const { data, error } = await supabase
      .from('productos')
      .select('codigo_barra, nombre, genero, color, talla, id_familia, activo')
      .in(columna, unicos.slice(i, i + 100));
    if (error) throw new Error(error.message);
    resultado.push(...((data as ProductoExistente[]) ?? []));
  }
  return resultado;
}

/**
 * Revisa ANTES de importar las dos condiciones que el servidor rechaza con
 * un mismo mensaje genérico ("ya existe ... el código o el mismo nombre/
 * género/color/talla"), para decirle al usuario exactamente qué artículo
 * choca: (1) el código ya existe, aunque el artículo esté inactivo; (2) ya
 * hay OTRO artículo activo con la misma familia, nombre, género, color y
 * talla, con otro código; o (3) dos filas del mismo archivo describen el
 * mismo artículo.
 */
async function verificarContraCatalogo(filas: FilaValida[]): Promise<{ validas: FilaValida[]; invalidas: FilaInvalida[] }> {
  const porCodigo = new Map((await consultarEnLotes('codigo_barra', filas.map((f) => f.codigo))).map((p) => [p.codigo_barra.toUpperCase(), p]));
  const activosPorClave = new Map(
    (await consultarEnLotes('nombre', filas.map((f) => f.nombre.trim().toUpperCase())))
      .filter((p) => p.activo)
      .map((p) => [claveArticulo(p.id_familia, p.nombre, p.genero, p.color, p.talla), p])
  );

  const validas: FilaValida[] = [];
  const invalidas: FilaInvalida[] = [];
  const filaPorClave = new Map<string, number>();
  for (const f of filas) {
    const clave = claveArticulo(f.id_familia, f.nombre, f.genero || null, f.color || null, f.talla || null);
    const mismoCodigo = porCodigo.get(f.codigo);
    const mismoArticulo = activosPorClave.get(clave);
    const filaPrevia = filaPorClave.get(clave);
    if (mismoCodigo) {
      invalidas.push({
        fila: f.fila,
        motivo: `${f.codigo}: el código ya existe en el catálogo (artículo "${mismoCodigo.nombre}", ${mismoCodigo.activo ? 'activo' : 'INACTIVO'}).`
          + (mismoCodigo.activo ? '' : ' Actívelo desde Artículos en vez de volver a cargarlo.'),
      });
    } else if (mismoArticulo) {
      invalidas.push({
        fila: f.fila,
        motivo: `${f.codigo}: ya existe el mismo artículo con otro código, ${mismoArticulo.codigo_barra} ("${mismoArticulo.nombre}"): misma familia, nombre, género, color y talla. Cambie algún dato o use ese código.`,
      });
    } else if (filaPrevia !== undefined) {
      invalidas.push({ fila: f.fila, motivo: `${f.codigo}: repite el artículo de la fila ${filaPrevia} (misma familia, nombre, género, color y talla).` });
    } else {
      filaPorClave.set(clave, f.fila);
      validas.push(f);
    }
  }
  return { validas, invalidas };
}

function normalizarClave(clave: string): string {
  return clave.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// A diferencia de un simple `.replace(',', '.')`, esto sí entiende números
// con separador de miles (formato natural al escribir plata en Colombia,
// ej. "38.500" o "1.200.000"). Trata el último punto/coma como separador
// decimal SOLO si le siguen 1 o 2 dígitos (formato de centavos); cualquier
// otro punto/coma se interpreta como separador de miles y se descarta. Sin
// esto, "38.500" se leía como 38.5 — corrupción silenciosa del valor
// inicial/saldo cargado.
function parsearNumero(textoOriginal: string): number {
  const texto = textoOriginal.trim();
  if (!texto) return 0;
  const match = texto.match(/[.,](\d{1,2})$/);
  if (match) {
    const enteros = texto.slice(0, texto.length - match[0].length).replace(/[.,]/g, '');
    return parseFloat(`${enteros}.${match[1]}`);
  }
  return parseFloat(texto.replace(/[.,]/g, ''));
}

// Lista de filas rechazadas (número de fila del archivo + motivo) para
// corregirlas sin tener que buscarlas a ojo entre cientos de filas.
function descargarRechazadas(invalidas: FilaInvalida[]) {
  const escapar = (t: string) => `"${t.replace(/"/g, '""')}"`;
  const contenido = ['fila;motivo', ...invalidas.map((f) => `${f.fila};${escapar(f.motivo)}`)].join('\n') + '\n';
  // BOM para que Excel abra las tildes correctamente.
  const blob = new Blob(['﻿' + contenido], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'filas_rechazadas_carga_masiva.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
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
  // Fecha contable con la que quedan los saldos iniciales en el kardex
  // (antes era siempre 01/03/2026, aunque la carga se hiciera otro día).
  const [fechaSaldo, setFechaSaldo] = useState(hoyISO);
  const limitesFecha = limitesFechaMovimiento();

  const reiniciar = () => {
    setNombreArchivo(''); setValidas([]); setInvalidas([]); setResultado(null);
    setProgreso({ hecho: 0, total: 0 });
    if (inputRef.current) inputRef.current.value = '';
  };

  const cerrar = () => {
    // Cerrar mientras `importar()` sigue corriendo en segundo plano dejaba
    // el estado obsoleto: la importación seguía escribiendo en Supabase, y
    // al terminar volcaba su resultado sobre un modal ya "reiniciado" (o
    // reabierto para un archivo distinto), mostrando resultados de una
    // sesión de importación que el usuario ya había abandonado.
    if (importando) return;
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

        const busqueda = buscarFamilia(familias, familiaTexto);
        if ('error' in busqueda) {
          malas.push({ fila: numFila, motivo: `${codigo}: ${busqueda.error}` });
          return;
        }
        const fam = busqueda.familia;

        const saldoInicial = parsearNumero(saldoTexto);
        if (isNaN(saldoInicial) || saldoInicial < 0) {
          malas.push({ fila: numFila, motivo: `Saldo inicial inválido "${saldoTexto}"` });
          return;
        }
        const valorInicial = parsearNumero(valorTexto);
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

      let buenasFinales = buenas;
      let malasFinales = malas;
      if (buenas.length > 0) {
        try {
          const revision = await verificarContraCatalogo(buenas);
          buenasFinales = revision.validas;
          malasFinales = [...malas, ...revision.invalidas].sort((a, b) => a.fila - b.fila);
        } catch {
          // Sin conexión para la revisión previa: se sigue igual, el servidor
          // vuelve a validar cada fila al importar y reporta el error ahí.
          toast('aviso', 'No se pudo verificar contra el catálogo actual; los duplicados se reportarán al importar.');
        }
      }

      setValidas(buenasFinales);
      setInvalidas(malasFinales);
      if (buenasFinales.length === 0) {
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
    if (!fechaSaldo || fechaSaldo < limitesFecha.min || fechaSaldo > limitesFecha.max) {
      toast('error', 'Seleccione una fecha del saldo inicial válida (desde el 01/03/2026 hasta hoy).');
      return;
    }
    setImportando(true);
    // Si la base de datos todavía no tiene la versión con p_fecha (falta
    // ejecutar actualizar_base.sql), PostgREST responde PGRST202 en cada
    // fila. En ese caso se reintenta sin la fecha (comportamiento anterior)
    // en vez de dejar fallar toda la carga.
    let enviarFecha = true;
    let avisoSinFecha = false;
    setProgreso({ hecho: 0, total: validas.length });
    const res: ResultadoFila[] = [];

    for (const fila of validas) {
      try {
        const parametros = {
          p_codigo_barra: fila.codigo,
          p_nombre: fila.nombre,
          p_id_familia: fila.id_familia,
          p_genero: fila.genero || null,
          p_color: fila.color || null,
          p_talla: fila.talla || null,
          p_saldo_inicial: fila.saldoInicial,
          p_valor_inicial: fila.valorInicial,
        };
        let { data, error } = await supabase.rpc('rpc_importar_articulo_inicial',
          enviarFecha ? { ...parametros, p_fecha: fechaSaldo } : parametros);
        if (error?.code === 'PGRST202' && enviarFecha) {
          enviarFecha = false;
          avisoSinFecha = true;
          ({ data, error } = await supabase.rpc('rpc_importar_articulo_inicial', parametros));
        }
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
    if (avisoSinFecha) {
      toast('aviso', 'La base de datos no está actualizada: los saldos iniciales quedaron con la fecha anterior (01/03/2026). Ejecute supabase/actualizar_base.sql.');
    }
    const creados = res.filter((r) => r.ok).length;
    // Las filas rechazadas en la revisión del archivo (familia inexistente,
    // código repetido, etc.) nunca llegan a `res`: hay que sumarlas aquí o
    // el mensaje final dice "completa" aunque parte del archivo no se cargó.
    const fallidos = res.length - creados + invalidas.length;
    if (creados > 0) onCompletado?.();
    if (fallidos === 0) {
      toast('exito', `Carga masiva completa: ${creados} artículo(s) cargado(s) con su saldo inicial`);
    } else {
      toast('aviso', `Carga masiva: ${creados} cargado(s), ${fallidos} NO cargado(s). Revise el detalle en rojo.`);
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
          <button onClick={cerrar} disabled={importando} className="rounded-lg p-1.5 text-pizarra-400 hover:bg-pizarra-100 hover:text-pizarra-700 transition disabled:opacity-30" aria-label="Cerrar">
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

        <div className="mt-4 max-w-xs">
          <label className="dt-label" htmlFor="fecha-saldo">Fecha del saldo inicial</label>
          <input
            id="fecha-saldo" type="date" className="dt-input"
            min={limitesFecha.min} max={limitesFecha.max}
            value={fechaSaldo}
            disabled={importando}
            onChange={(e) => setFechaSaldo(e.target.value)}
          />
          <p className="mt-1 text-[12px] text-pizarra-400">Fecha con la que el saldo inicial queda en el kardex. Por defecto, hoy.</p>
        </div>

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

        {invalidas.length > 0 && !analizando && (
          <div className="mt-3 flex flex-col gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-[12.5px] text-amber-800 sm:flex-row sm:items-center sm:justify-between">
            <span>
              <strong>{invalidas.length} de {validas.length + invalidas.length} fila(s) del archivo NO se cargarán.</strong>{' '}
              Corríjalas y vuelva a subir solo esas filas.
            </span>
            <button type="button" onClick={() => descargarRechazadas(invalidas)} className="inline-flex shrink-0 items-center gap-1.5 font-semibold text-amber-900 hover:underline">
              <Download size={14} /> Descargar lista
            </button>
          </div>
        )}

        {resultado && (
          <div className="mt-4 max-h-48 overflow-auto rounded-lg border border-pizarra-200">
            <p className="sticky top-0 border-b border-pizarra-200 bg-pizarra-50 px-3 py-2 text-[12.5px] font-semibold text-pizarra-600">
              Resultado: {resultado.filter((r) => r.ok).length} cargado(s) · {resultado.filter((r) => !r.ok).length} con error al cargar
              {invalidas.length > 0 && ` · ${invalidas.length} rechazado(s) en la revisión del archivo`}
            </p>
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
          <button type="button" className="dt-btn dt-btn-ghost" onClick={cerrar} disabled={importando}>Cerrar</button>
          <button type="button" className="dt-btn dt-btn-primary" disabled={validas.length === 0 || importando || deshabilitado} onClick={importar}>
            <Upload size={16} /> {importando ? 'Importando…' : invalidas.length > 0
              ? `Importar ${validas.length} de ${validas.length + invalidas.length}`
              : `Importar ${validas.length || ''} artículo(s)`}
          </button>
        </div>
      </div>
    </div>
  );
}
