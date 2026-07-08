// ============================================================
// Persistencia de borradores locales · carrito POS y formularios
// de Entradas/Salidas frente a recargas accidentales (F5).
//
// Cada borrador queda aislado por id de usuario: si en el mismo
// navegador otra persona inicia sesión, su borrador no hereda
// datos de la sesión anterior (evita mezclar información entre
// usuarios distintos de un mismo equipo).
// ============================================================

interface Envoltorio<T> {
  uid: string;
  guardadoEn: number;
  datos: T;
}

/** Un borrador más viejo que esto se descarta por considerarse obsoleto */
const VIGENCIA_MS = 1000 * 60 * 60 * 12; // 12 horas

export function guardarBorrador<T>(clave: string, uid: string, datos: T): void {
  try {
    const envoltorio: Envoltorio<T> = { uid, guardadoEn: Date.now(), datos };
    localStorage.setItem(clave, JSON.stringify(envoltorio));
  } catch {
    // Almacenamiento no disponible (modo privado, cuota excedida, etc.)
    // Se ignora silenciosamente: perder el borrador no debe romper la UI.
  }
}

export function leerBorrador<T>(clave: string, uid: string): T | null {
  try {
    const crudo = localStorage.getItem(clave);
    if (!crudo) return null;
    const envoltorio = JSON.parse(crudo) as Envoltorio<T>;
    if (!envoltorio || envoltorio.uid !== uid) return null;
    if (Date.now() - envoltorio.guardadoEn > VIGENCIA_MS) {
      localStorage.removeItem(clave);
      return null;
    }
    return envoltorio.datos;
  } catch {
    return null;
  }
}

export function borrarBorrador(clave: string): void {
  try {
    localStorage.removeItem(clave);
  } catch {
    // noop
  }
}

export const CLAVE_BORRADOR_ENTRADA = 'dt_borrador_entrada';
export const CLAVE_BORRADOR_SALIDA = 'dt_borrador_salida';
export const CLAVE_CARRITO_POS = 'dt_pos_carrito';

/** Limpia todos los borradores conocidos · usar siempre al cerrar sesión */
export function borrarTodosLosBorradores(): void {
  [CLAVE_BORRADOR_ENTRADA, CLAVE_BORRADOR_SALIDA, CLAVE_CARRITO_POS].forEach(borrarBorrador);
}
