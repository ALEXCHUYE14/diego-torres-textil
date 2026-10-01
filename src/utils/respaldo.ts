// ============================================================
// Respaldo completo del inventario en Excel (.xlsx)
//
// Una hoja por tabla de la base de datos, con exactamente las mismas
// columnas (mismo nombre y orden que en Supabase) y los mismos valores:
// números como números, texto como texto y fechas en el formato ISO tal
// como están guardadas. La primera hoja "Resumen" indica cuándo y quién
// generó el respaldo y cuántas filas tiene cada tabla, para poder
// verificar que no falte nada.
//
// Solo lectura: no modifica ningún dato.
// ============================================================
import * as XLSX from 'xlsx';
import { obtenerTodasLasFilas, supabase } from '../lib/supabase';

interface TablaRespaldo {
  tabla: string;
  descripcion: string;
  /** Columnas de orden: la última siempre es la llave primaria, para que
   *  la paginación por rangos sea estable y no repita ni salte filas. */
  orden: string[];
}

const TABLAS: TablaRespaldo[] = [
  { tabla: 'productos', descripcion: 'Artículos del catálogo con stock y costos', orden: ['codigo_barra', 'id_producto'] },
  { tabla: 'historial_movimientos', descripcion: 'Kardex: todas las entradas y salidas', orden: ['fecha_registro', 'tipo_consecutivo', 'id_movimiento'] },
  { tabla: 'familias', descripcion: 'Familias de artículos', orden: ['codigo', 'id_familia'] },
  { tabla: 'generos', descripcion: 'Catálogo de géneros', orden: ['nombre', 'id_genero'] },
  { tabla: 'colores', descripcion: 'Catálogo de colores', orden: ['nombre', 'id_color'] },
  { tabla: 'tallas', descripcion: 'Catálogo de tallas', orden: ['nombre', 'id_talla'] },
  { tabla: 'terceros', descripcion: 'Proveedores', orden: ['razon_social', 'id_proveedor'] },
  { tabla: 'clientes', descripcion: 'Clientes', orden: ['nombre', 'id_cliente'] },
  { tabla: 'periodos_bloqueados', descripcion: 'Meses cerrados', orden: ['anio_mes'] },
  { tabla: 'ventas', descripcion: 'Ventas (tickets)', orden: ['fecha', 'id_venta'] },
  { tabla: 'venta_items', descripcion: 'Detalle de cada venta', orden: ['venta_id', 'id_item'] },
  { tabla: 'usuarios', descripcion: 'Usuarios del sistema y su rol', orden: ['nombre', 'id_usuario'] },
];

type Fila = Record<string, unknown>;

/** Excel no admite objetos/arreglos en una celda: se guardan como JSON. */
function aCelda(valor: unknown): unknown {
  if (valor === null || valor === undefined) return null;
  if (typeof valor === 'object') return JSON.stringify(valor);
  return valor;
}

async function leerTabla(t: TablaRespaldo): Promise<Fila[]> {
  return obtenerTodasLasFilas<Fila>((desde, hasta) => {
    let consulta = supabase.from(t.tabla).select('*');
    for (const col of t.orden) consulta = consulta.order(col, { ascending: true });
    return consulta.range(desde, hasta);
  });
}

function hojaDesdeFilas(filas: Fila[]): XLSX.WorkSheet {
  if (filas.length === 0) return XLSX.utils.aoa_to_sheet([['(tabla sin registros)']]);
  // Columnas en el mismo orden en que las entrega la base de datos.
  const columnas = Object.keys(filas[0]);
  const datos = filas.map((f) => columnas.map((c) => aCelda(f[c])));
  const hoja = XLSX.utils.aoa_to_sheet([columnas, ...datos]);
  // Ancho de columna según el contenido (muestra de las primeras 200 filas).
  hoja['!cols'] = columnas.map((c, j) => ({
    wch: Math.min(60, Math.max(c.length, ...datos.slice(0, 200).map((fila) => String(fila[j] ?? '').length)) + 2),
  }));
  hoja['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: filas.length, c: columnas.length - 1 } }) };
  return hoja;
}

const dos = (n: number) => String(n).padStart(2, '0');

/**
 * Lee todas las tablas y descarga el archivo. Si alguna tabla falla (por
 * ejemplo, no existe en esta base), el respaldo se genera igual con el
 * resto y la falla queda anotada en la hoja Resumen — nunca se entrega un
 * archivo incompleto sin avisarlo. Devuelve los nombres de las tablas que
 * fallaron.
 */
export async function descargarRespaldoExcel(generadoPor: string): Promise<{ archivo: string; fallidas: string[] }> {
  const ahora = new Date();
  const resultados = await Promise.all(
    TABLAS.map(async (t) => {
      try {
        return { t, filas: await leerTabla(t), error: null as string | null };
      } catch (e) {
        return { t, filas: [] as Fila[], error: e instanceof Error ? e.message : String(e) };
      }
    })
  );

  const libro = XLSX.utils.book_new();
  const resumen: unknown[][] = [
    ['Respaldo de inventario · Comercializadora T&E S.A.S.'],
    ['Generado', `${dos(ahora.getDate())}/${dos(ahora.getMonth() + 1)}/${ahora.getFullYear()} ${dos(ahora.getHours())}:${dos(ahora.getMinutes())}`],
    ['Generado por', generadoPor],
    [],
    ['Hoja / tabla', 'Contenido', 'Filas', 'Estado'],
    ...resultados.map(({ t, filas, error }) => [t.tabla, t.descripcion, error ? null : filas.length, error ? `ERROR: ${error}` : 'Completa']),
  ];
  const hojaResumen = XLSX.utils.aoa_to_sheet(resumen);
  hojaResumen['!cols'] = [{ wch: 24 }, { wch: 44 }, { wch: 10 }, { wch: 40 }];
  XLSX.utils.book_append_sheet(libro, hojaResumen, 'Resumen');

  for (const { t, filas, error } of resultados) {
    const hoja = error ? XLSX.utils.aoa_to_sheet([[`No se pudo leer esta tabla: ${error}`]]) : hojaDesdeFilas(filas);
    XLSX.utils.book_append_sheet(libro, hoja, t.tabla.slice(0, 31));
  }

  const archivo = `respaldo_inventario_${ahora.getFullYear()}-${dos(ahora.getMonth() + 1)}-${dos(ahora.getDate())}_${dos(ahora.getHours())}${dos(ahora.getMinutes())}.xlsx`;
  XLSX.writeFile(libro, archivo, { compression: true });
  return { archivo, fallidas: resultados.filter((r) => r.error).map((r) => r.t.tabla) };
}
