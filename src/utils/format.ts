// Utilidades de formato · moneda COP, fechas y números

const fmtMoneda = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const fmtNumero = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 2 });

export const moneda = (n: number | null | undefined): string =>
  fmtMoneda.format(Number(n ?? 0));

export const numero = (n: number | null | undefined): string =>
  fmtNumero.format(Number(n ?? 0));

/** Fecha segura: descarta nulos y fechas basura de sistemas antiguos (30/12/1899) */
export const fechaSegura = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime()) || d.getFullYear() < 1990) return '—';
  return d.toLocaleDateString('es-CO', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
};

export const soloFecha = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime()) || d.getFullYear() < 1990) return '—';
  return d.toLocaleDateString('es-CO');
};

/**
 * Fecha de un MOVIMIENTO de inventario (Entrada/Salida). El servidor guarda
 * `fecha_registro` como medianoche UTC explícita (ver migration_006) porque
 * es una fecha de calendario elegida por el usuario, no un instante real.
 * Leerla con los métodos LOCALES de Date (getFullYear/toLocaleDateString)
 * la corre un día hacia atrás en cualquier zona horaria detrás de UTC
 * (Colombia, Perú...) — por eso aquí se usan los métodos UTC explícitamente.
 * No usar esta función para instantes reales (ej. fecha_creacion): para eso
 * `fechaSegura`/`soloFecha` (hora local) siguen siendo lo correcto.
 */
export const fechaMovimiento = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime()) || d.getUTCFullYear() < 1990) return '—';
  const dia = String(d.getUTCDate()).padStart(2, '0');
  const mes = String(d.getUTCMonth() + 1).padStart(2, '0');
  const anio = d.getUTCFullYear();
  return `${dia}/${mes}/${anio}`;
};

export const hoyISO = (): string => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** Fecha desde la que el sistema permite registrar movimientos (carga inicial de inventario) */
export const FECHA_INICIO_OPERACION = '2026-03-01';

/** Límites (min/max) permitidos para fechas de movimiento: desde el inicio de
 *  operación del sistema hasta hoy (no se permiten fechas futuras). */
export const limitesFechaMovimiento = (): { min: string; max: string } => ({
  min: FECHA_INICIO_OPERACION,
  max: hoyISO(),
});
