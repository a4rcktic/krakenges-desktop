/**
 * Formateo honesto de datos.
 *
 * REGLA: si el backend no manda un dato, se pinta "—". Nunca un valor por
 * defecto que parezca medido.
 *
 * De aqui salieron cosas como "2h 25m" fijos en el panel movil, que se leian
 * como tiempo real de uso. Un cero es un dato; una raya es la ausencia de dato.
 * No son lo mismo y el usuario tiene derecho a distinguirlos.
 */

/** Raya para un dato que no existe. No es un cero. */
export const DASH = '—';

/** Minutos -> "2h 5m" / "45m" / "0m". `null` o `undefined` -> "—". */
export function formatMinutes(total?: number | null): string {
  if (total === null || total === undefined || !Number.isFinite(total)) return DASH;
  const safe = Math.max(0, Math.floor(total));
  const hours = Math.floor(safe / 60);
  const minutes = safe % 60;
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

/**
 * Numero de una tarjeta: 0 se respeta, `null`/`undefined` se pintan "—".
 * Usar `?? 0` esta bien cuando el backend garantiza el campo (un contador de
 * Mongo siempre devuelve numero); esto es para campos opcionales.
 */
export function formatCount(value?: number | null): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  return String(value);
}

/** Texto opcional: recorta y devuelve "—" si esta vacio. */
export function formatText(value?: string | null): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : DASH;
}
