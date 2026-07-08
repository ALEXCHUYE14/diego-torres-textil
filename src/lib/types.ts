// ============================================================
// Tipos del dominio · Diego Torres Textil
// ============================================================

export type Rol = 'consulta' | 'operativo';

export interface Familia {
  id_familia: string;
  codigo: string;
  nombre: string;
  consecutivo_familia: number;
}

export interface Producto {
  id_producto: string;
  codigo_barra: string;
  nombre: string;
  genero: string;
  color: string;
  talla: string;
  id_familia: string;
  stock_real: number;
  costo_promedio_ponderado: number;
  valor_unitario_inicial: number;
  ultimo_valor_unitario: number;
  precio_venta: number;
  activo: boolean;
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

export const TIPOS_ENTRADA = [
  { codigo: '1000', nombre: 'Compra a proveedor' },
  { codigo: '1002', nombre: 'Devolución de cliente' },
  { codigo: '1007', nombre: 'Ajuste positivo de inventario' },
  { codigo: '1210', nombre: 'Traslado entre bodegas (ingreso)' },
];

export const TIPOS_SALIDA = [
  { codigo: '2000', nombre: 'Venta / Despacho' },
  { codigo: '2003', nombre: 'Ajuste negativo de inventario' },
];

export const GENEROS = ['HOMBRE', 'MUJER', 'UNISEX', 'NINO', 'NINA'];
export const TALLAS = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'UNICA'];
