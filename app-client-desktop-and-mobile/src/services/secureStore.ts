import { isTauri, coreInvoke as tauriInvoke } from './tauriCore';
export { isTauri };

export interface HwidInfo {
  hwid: string;
  os_name: string;
  kernel: string;
  cpu_count: number;
}

export async function getClientHwid(): Promise<HwidInfo | undefined> {
  if (!isTauri) return undefined;
  try {
    return await tauriInvoke<HwidInfo>('get_hwid');
  } catch {
    return undefined;
  }
}

// Almacen seguro respaldado por el llavero del SO (Keychain/DPAPI/libsecret).
// En Tauri los secretos NUNCA se escriben en localStorage; en navegador
// (solo desarrollo) degrada a localStorage.
export const secureStore = {
  async get(key: string): Promise<string | null> {
    if (isTauri) {
      try {
        const value = await tauriInvoke<string | null>('secure_get', { key });
        if (value !== null) return value;
      } catch {
        /* degrade */
      }
    }
    return window.localStorage.getItem(key);
  },

  async set(key: string, value: string): Promise<void> {
    if (isTauri) {
      try {
        await tauriInvoke('secure_set', { key, value });
        window.localStorage.removeItem(key);
        return;
      } catch {
        /* degrade for dev */
      }
    }
    window.localStorage.setItem(key, value);
  },

  async remove(key: string): Promise<void> {
    if (isTauri) {
      try {
        await tauriInvoke('secure_delete', { key });
      } catch {
        /* ignore */
      }
    }
    window.localStorage.removeItem(key);
  },
};