use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use keyring::Entry;

/// Almacenamiento seguro respaldado por el llavero del sistema operativo:
/// - macOS: Keychain
/// - Windows: Credential Manager (DPAPI)
/// - Linux: Secret Service (libsecret / gnome-keyring, KWallet, etc.)
///
/// Los tokens de sesión NO deben vivir en localStorage (texto plano en disco).
/// Si el llavero no está disponible (entorno headless), se degrada a un
/// almacén en memoria no persistente para no romper la sesión en el proceso.

const SERVICE: &str = crate::brand::TAURI_IDENTIFIER;

static MEM_FALLBACK: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn entry(key: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, key).map_err(|e| format!("Error abriendo el llavero: {}", e))
}

#[tauri::command]
pub fn secure_get(key: String) -> Result<Option<String>, String> {
    match entry(&key) {
        Ok(entry) => match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => {
                let m = e.to_string();
                if m.contains("no available service") || m.contains("SSH_AUTH_SOCK") {
                    Ok(MEM_FALLBACK.lock().unwrap().get(&key).cloned())
                } else {
                    Err(format!("Error leyendo del llavero: {}", m))
                }
            }
        },
        Err(e) => {
            if e.contains("no available service") {
                Ok(MEM_FALLBACK.lock().unwrap().get(&key).cloned())
            } else {
                Err(e)
            }
        }
    }
}

#[tauri::command]
pub fn secure_set(key: String, value: String) -> Result<(), String> {
    match entry(&key) {
        Ok(entry) => entry
            .set_password(&value)
            .map_err(|e| format!("Error guardando en el llavero: {}", e)),
        Err(e) => {
            if e.contains("no available service") {
                MEM_FALLBACK.lock().unwrap().insert(key, value);
                Ok(())
            } else {
                Err(e)
            }
        }
    }
}

#[tauri::command]
pub fn secure_delete(key: String) -> Result<(), String> {
    MEM_FALLBACK.lock().unwrap().remove(&key);
    match entry(&key) {
        Ok(entry) => match entry.delete_password() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("Error eliminando del llavero: {}", e)),
        },
        Err(e) => {
            if e.contains("no available service") {
                Ok(())
            } else {
                Err(e)
            }
        }
    }
}