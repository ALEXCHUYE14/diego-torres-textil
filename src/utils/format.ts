// Utilidades de formato · moneda PEN, fechas y números

const fmtMoneda = new Intl.NumberFormat('es-PE', {
  style: 'currency',
  currency: 'PEN',
  minimumFractionDigits: 2,
});

const fmtNumero = new Intl.NumberFormat('es-PE', { maximumFractionDigits: 2 });

export const moneda = (n: number | null | undefined): string =>
  fmtMoneda.format(Number(n ?? 0));

export const numero = (n: number | null | undefined): string =>
  fmtNumero.format(Number(n ?? 0));

/** Fecha segura: descarta nulos y fechas basura de sistemas antiguos (30/12/1899) */
export const fechaSegura = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime()) || d.getFullYear() < 1990) return '—';
  return d.toLocaleDateString('es-PE', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
};

export const soloFecha = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime()) || d.getFullYear() < 1990) return '—';
  return d.toLocaleDateString('es-PE');
};

/** Límites (min/max) del mes actual del servidor para inputs type=date */
export const limitesMesActual = (): { min: string; max: string } => {
  const hoy = new Date();
  const y = hoy.getFullYear();
  const m = hoy.getMonth();
  const pad = (n: number) => String(n).padStart(2, '0');
  const ultimo = new Date(y, m + 1, 0).getDate();
  return {
    min: `${y}-${pad(m + 1)}-01`,
    max: `${y}-${pad(m + 1)}-${pad(ultimo)}`,
  };
};

export const hoyISO = (): string => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
