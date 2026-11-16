use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewBuilder, WebviewUrl};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RectBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Default)]
pub struct EmbeddedBrowserManager {
    // Mapa de profile_id -> label del webview hijo
    pub active_views: Mutex<HashMap<String, String>>,
}

/// Directorio de datos de perfil 100% aislado en disco.
/// Valida `profile_id` (viene por IPC) antes de tocar el sistema de ficheros.
pub fn get_embedded_profile_dir(profile_id: &str) -> Result<PathBuf, String> {
    let root = crate::paths::data_dir()
        .ok_or_else(|| "No se pudo determinar el directorio de usuario".to_string())?;
    let data_dir = crate::paths::profile_dir(&root.join("embedded_profiles"), profile_id)?;
    std::fs::create_dir_all(&data_dir)
        .map_err(|e| format!("Error creando directorio de perfil embebido: {}", e))?;
    Ok(data_dir)
}

#[tauri::command]
pub async fn create_embedded_browser(
    app: AppHandle,
    profile_id: String,
    url: String,
    bounds: RectBounds,
    state: tauri::State<'_, EmbeddedBrowserManager>,
) -> Result<bool, String> {
    // Validar ANTES de tomar el lock: `profile_id` llega por IPC y se usa tanto
    // para la ruta en disco como para la etiqueta del webview.
    crate::paths::validate_profile_id(&profile_id)?;
    let mut views = state.active_views.lock().unwrap();
    let view_label = format!("child_webview_{}", profile_id);

    // Si ya existe la vista, cerrarla para renovar
    if let Some(existing) = app.get_webview(&view_label) {
        let _ = existing.close();
    }

    let target_window = app.get_window("main").ok_or("Ventana principal no encontrada")?;

    let parsed_url = if url.trim().is_empty() {
        WebviewUrl::External("https://pixelscan.net".parse().map_err(|e| format!("{:?}", e))?)
    } else {
        WebviewUrl::External(url.parse().map_err(|e| format!("{:?}", e))?)
    };

    let profile_data_dir = get_embedded_profile_dir(&profile_id)?;

    // Creación de Webview secundario DENTRO de la ventana principal
    let webview_builder = WebviewBuilder::new(&view_label, parsed_url)
        .data_directory(profile_data_dir);

    match target_window.add_child(
        webview_builder,
        PhysicalPosition::new(bounds.x as i32, bounds.y as i32),
        PhysicalSize::new(bounds.width as u32, bounds.height as u32),
    ) {
        Ok(_webview) => {
            views.insert(profile_id, view_label);
            Ok(true)
        }
        Err(e) => Err(format!("Error incrustando vista web: {}", e)),
    }
}

#[tauri::command]
pub fn resize_embedded_browser(
    app: AppHandle,
    profile_id: String,
    bounds: RectBounds,
    state: tauri::State<'_, EmbeddedBrowserManager>,
) -> Result<bool, String> {
    let views = state.active_views.lock().unwrap();
    if let Some(label) = views.get(&profile_id) {
        if let Some(webview) = app.get_webview(label) {
            let _ = webview.set_position(PhysicalPosition::new(bounds.x as i32, bounds.y as i32));
            let _ = webview.set_size(PhysicalSize::new(bounds.width as u32, bounds.height as u32));
            return Ok(true);
        }
    }
    Ok(false)
}

#[tauri::command]
pub fn close_embedded_browser(
    app: AppHandle,
    profile_id: String,
    state: tauri::State<'_, EmbeddedBrowserManager>,
) -> Result<bool, String> {
    let mut views = state.active_views.lock().unwrap();
    if let Some(label) = views.remove(&profile_id) {
        if let Some(webview) = app.get_webview(&label) {
            let _ = webview.close();
            return Ok(true);
        }
    }
    Ok(false)
}
