// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "linux")]
    {
        // WebKitGTK compatibility across all Linux distros (Arch, Fedora, Ubuntu).
        // WebKit's DMABUF renderer fails to build framebuffers on many NVIDIA /
        // Wayland setups leaving a blank window. tauri-apps/tauri#9394
        if std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER").is_err() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }

        // En X11 con GPU Intel el compositor acelerado de WebKitGTK puede
        // quedarse repintando la interfaz aunque no haya cambios. Medido en
        // esta app: la vista de perfiles pasaba de ~50-80% de CPU a ~12-40%
        // con el compositing desactivado, con el mismo aspecto visual.
        // La interfaz es 2D; se puede sobrescribir con la variable de entorno.
        if std::env::var("WEBKIT_DISABLE_COMPOSITING_MODE").is_err() {
            std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        }

        // The AppImage linuxdeploy GTK hook forces GDK_BACKEND=x11, which leaves
        // a blank window on Arch with a Wayland-only session. Prefer Wayland and
        // fall back to X11 on plain X11 setups.
        if let Ok(backend) = std::env::var("GDK_BACKEND") {
            if backend.trim() == "x11" {
                std::env::set_var("GDK_BACKEND", "wayland,x11");
            }
        }

        if std::env::var("RESOURCE_NAME").is_err() {
            std::env::set_var("RESOURCE_NAME", krakenges_app_lib::brand::SLUG);
        }
    }

    krakenges_app_lib::run()
}
