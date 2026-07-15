// ============================================================
// Tipos del dominio · Diego Torres Textil
// ============================================================

/**
 * Tres roles reales en la base de datos (ver migration_007_rbac.sql):
 *  - consulta:      solo lectura en todo el sistema.
 *  - operativo:     crea artículos, registra entradas/salidas, consulta kardex.
 *                   No puede eliminar artículos ni gestionar usuarios ni
 *                   cerrar/abrir meses.
 *  - administrador: todo lo anterior + eliminar artículos + gestión de
 *                   usuarios + cierre de mes.
 */
export type Rol = 'consulta' | 'operativo' | 'administrador';

export const ROLES_ASIGNABLES: { valor: Rol; etiqueta: string }[] = [
  { valor: 'operativo', etiqueta: 'Operativo' },
  { valor: 'consulta', etiqueta: 'Consulta' },
];

export const etiquetaRol = (r: Rol): string => {
  if (r === 'administrador') return 'Administrador';
  if (r === 'operativo') return 'Operativo';
  return 'Consulta';
};

export interface Usuario {
  id_usuario: string;
  nombre: string;
  correo: string | null;
  rol: Rol;
}

export interface Familia {
  id_familia: string;
  codigo: string;
  nombre: string;
  consecutivo_familia: number;
}

export interface Genero {
  id_genero: string;
  nombre: string;
  activo: boolean;
}

export interface Color {
  id_color: string;
  nombre: string;
  activo: boolean;
}

export interface Talla {
  id_talla: string;
  nombre: string;
  activo: boolean;
}

export interface Producto {
  id_producto: string;
  codigo_barra: string;
  nombre: string;
  genero: string | null;
  color: string | null;
  talla: string | null;
  id_familia: string;
  stock_real: number;
  costo_promedio_ponderado: number;
  valor_unitario_inicial: number;
  ultimo_valor_unitario: number;
  precio_venta: number;
  activo: boolean;
  tiene_movimientos: boolean;
  fecha_creacion: string;
}

export interface Proveedor {
  id_proveedor: string;
  nit_documento: string;
  razon_social: string;
  correo: string | null;
  telefono: string | null;
}

export interface Cliente {
  id_cliente: string;
  documento: string;
  nombre: string;
  correo: string | null;
  telefono: string | null;
  ultima_compra: string | null;
}

export interface Movimiento {
  id_movimiento: string;
  tipo_consecutivo: string;
  documento_numero?: string;
  tipo_movimiento: string;
  naturaleza: 'ENTRADA' | 'SALIDA';
  fecha_registro: string;
  producto_id: string;
  cantidad: number;
  valor_unitario: number;
  valor_total: number;
  stock_resultante: number;
  nro_factura: string | null;
  nro_orden: string | null;
  concepto: string | null;
  proveedor?: string | null;
}

export interface PeriodoBloqueado {
  anio_mes: string;
  bloqueado_por: string | null;
  bloqueado_en: string;
  nota: string | null;
}

export interface DetalleProducto {
  producto: Producto;
  stock_inicial: number;
  entradas_mes: number;
  salidas_mes: number;
  consumo_promedio: number;
  duracion_dias: number;
  existencias: number;
  valorizacion: number;
  valor_ajustable: number;
  valor_reposicion: number;
  valor_actual: number;
}

export interface InformeCierre {
  stock_inicial: number;
  entradas: number;
  salidas: number;
  stock_final: number;
  rotacion: number;
  cobertura_dias: number;
  promedio_entradas: number;
  promedio_salidas: number;
  producto_top: string;
  producto_mayor_stock: string;
  valor_inicial: number;
  valor_final: number;
  ocupacion_pct: number;
  grid: FilaInforme[];
}

export interface FilaInforme {
  codigo: string;
  descripcion: string;
  stock_inicial: number;
  entradas: number;
  salidas: number;
  stock_final: number;
  valor_total: number;
}

export interface ItemCarrito {
  producto: Producto;
  cantidad: number;
}

/** Una línea dentro del formulario maestro-detalle de Entradas/Salidas (aún sin guardar) */
export interface LineaMovimiento {
  clave: string; // id local para React (no es el id de la fila en base de datos)
  producto: Producto;
  cantidad: string;
  valorUnitario: string; // solo aplica a Entradas; en Salidas se calcula por CPP
}

/** Documento impreso (Entrada o Salida) devuelto por rpc_obtener_documento */
export interface DocumentoItem {
  fecha_registro: string;
  tipo_movimiento: string;
  naturaleza: 'ENTRADA' | 'SALIDA';
  producto_nombre: string;
  proveedor_nombre: string | null;
  cantidad: number;
  valor_unitario: number;
  valor_total: number;
}

export interface DocumentoMovimiento {
  documento_numero: string;
  fecha_registro: string;
  tipo_movimiento: string;
  naturaleza: 'ENTRADA' | 'SALIDA';
  proveedor: Proveedor | null;
  usuario_nombre: string | null;
  items: DocumentoItem[];
  total: number;
  cantidad_total: number;
}

export const TIPOS_ENTRADA = [
  { codigo: '1000', nombre: 'Entrada por orden de compra' },
  { codigo: '1002', nombre: 'Entrada por terceros o satélites' },
  { codigo: '1007', nombre: 'Devoluciones' },
  { codigo: '1210', nombre: 'Devolución de insumos de OP' },
];

export const TIPOS_SALIDA = [
  { codigo: '2000', nombre: 'Salida a OP' },
  { codigo: '2003', nombre: 'Salida entrega cliente' },
];
