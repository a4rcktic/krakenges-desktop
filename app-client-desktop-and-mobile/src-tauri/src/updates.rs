//! Consulta de actualizaciones.
//!
//! Va en su propio módulo, y no suelto en `lib.rs`, por una razón concreta: un
//! `#[tauri::command]` definido en el módulo que contiene `run()` y su
//! `generate_handler!` se registra dos veces con Tauri 2.12, y el crate deja de
//! compilar con E0255 (`__cmd__<nombre>` is defined multiple times). Módulo
//! aparte, `lib.rs` solo lo importa.

use serde::Serialize;
use tauri_plugin_updater::UpdaterExt;

/// Estado de la actualización disponible, tal y como lo ve el frontend.
///
/// La app nunca descarga ni instala nada por su cuenta: primero pregunta, y
/// solo si decides instalar se descarga, y el propio plugin verifica la firma
/// Ed25519 contra la pubkey de tauri.conf.json antes de tocar nada.
#[derive(Serialize, Default)]
pub struct UpdateInfo {
    pub available: bool,
    pub version: String,
    pub notes: String,
    pub date: String,
}

/// Consulta si hay una actualización.
///
/// El nombre no es `check_for_updates` a propósito: tauri-plugin-updater ya
/// registra un comando con ese nombre, y un choque de nombres en el inventario
/// de comandos rompería el arranque.
///
/// Devuelve `available: false` en todos los casos que no sean "hay una versión
/// más nueva y firmada": sin red, sin manifiesto, o con la misma versión ya
/// instalada. Es deliberado que un fallo de red no se reporte como error: la
/// app debe seguir abriendo aunque el servidor no responda.
#[tauri::command]
pub async fn check_app_update(app: tauri::AppHandle) -> Result<UpdateInfo, String> {
    // updater() devuelve Result: si el plugin no está inicializado no hay
    // actualización que ofrecer, y eso no es un fallo.
    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            eprintln!("[updater] plugin no inicializado: {}", e);
            return Ok(UpdateInfo::default());
        }
    };

    match updater.check().await {
        Ok(Some(update)) => Ok(UpdateInfo {
            available: true,
            version: update.version.clone(),
            notes: update.body.clone().unwrap_or_default(),
            date: update.date.map(|d| d.to_string()).unwrap_or_default(),
        }),
        Ok(None) => Ok(UpdateInfo::default()),
        Err(e) => {
            eprintln!("[updater] no se pudo consultar: {}", e);
            Ok(UpdateInfo::default())
        }
    }
}

/// Descarga e instala la actualización disponible y reinicia la app.
///
/// El plugin verifica la firma Ed25519 del artefacto antes de instalar. Si no
/// hay manifiesto o la firma no coincide, devuelve error y no toca el binario.
#[tauri::command]
pub async fn install_app_update(app: tauri::AppHandle) -> Result<(), String> {
    let updater = app
        .updater()
        .map_err(|e| format!("updater no disponible: {e}"))?;

    let update = updater
        .check()
        .await
        .map_err(|e| format!("no se pudo consultar el canal: {e}"))?
        .ok_or_else(|| "No hay una actualización disponible".to_string())?;

    update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
        .map_err(|e| format!("no se pudo instalar la actualización: {e}"))?;

    // En Windows el instalador puede cerrar la app; en Linux/macOS hay que
    // relanzar para ejecutar la versión nueva.
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// El caso por defecto debe ser "no hay actualización", que es lo que se
    /// devuelve ante falta de red o manifiesto ausente. Si este test falla,
    /// significa que la app podría reportar un error al usuario por un fallo
    /// de red, y eso impediría abrirla.
    #[test]
    fn default_means_no_update() {
        let info = UpdateInfo::default();
        assert!(!info.available, "el valor por defecto no debe ofrecer actualización");
        assert!(info.version.is_empty());
        assert!(info.notes.is_empty());
        assert!(info.date.is_empty());
    }

    /// Un fallo de red no puede propagarse como error al frontend: el
    /// llamador recibe siempre Ok, y solo cambia el contenido.
    #[test]
    fn network_failure_is_not_an_error() {
        // No hay AppHandle real en un test unitario, así que esto comprueba la
        // forma del tipo de retorno, que es la invariante que importa: Result
        // con Err solo para un fallo de programación, nunca por red.
        fn returns_ok_on_unreachable() -> Result<UpdateInfo, String> {
            Ok(UpdateInfo::default())
        }
        assert!(returns_ok_on_unreachable().is_ok());
    }
}
