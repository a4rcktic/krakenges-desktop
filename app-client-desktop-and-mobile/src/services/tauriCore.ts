/**
 * Núcleo mínimo de Tauri.
 *
 * Vive separado de `tauriBridge` para que módulos de bajo nivel (como
 * `secureStore`) puedan detectar Tauri e invocar IPC sin crear un ciclo de
 * imports con el bridge web completo.
 */

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export async function coreInvoke<T = any>(command: string, args?: Record<string, any>): Promise<T> {
  if (!isTauri) {
    throw new Error('Tauri IPC no disponible fuera de la app de escritorio');
  }
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args ?? {});
}
