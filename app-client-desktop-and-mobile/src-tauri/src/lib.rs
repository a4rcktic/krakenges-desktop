pub mod api;
pub mod backend;
pub mod brand;
pub mod cdp;
pub mod embedded;
pub mod engine_install;
pub mod guard;
pub mod hardware;
pub mod launcher;
pub mod license;
pub mod paths;
pub mod pools;
pub mod proxy;
pub mod secure_store;
pub mod updates;

pub use embedded::{close_embedded_browser, create_embedded_browser, resize_embedded_browser, EmbeddedBrowserManager};
pub use launcher::{
    browser_clear_cookies, browser_get_cookies, browser_set_cookies, reset_profile_traffic, close_profile,
    is_profile_running, launch_isolated_profile, profile_traffic, check_engine_status, check_engine_update,
    install_dedicated_engine, ProcessManager,
};
pub use license::get_hwid;
pub use proxy::{parse_proxy_string, test_proxy_connection};
pub use secure_store::{secure_delete, secure_get, secure_set};
use updates::{check_app_update, install_app_update};


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = guard::run_startup_guard();
    tauri::Builder::default()
        .manage(ProcessManager::default())
        .manage(EmbeddedBrowserManager::default())
        .plugin(tauri_plugin_opener::init())
        // Updater nativo de Tauri. Verifica la firma Ed25519 del artefacto
        // (plugins.updater.pubkey en tauri.conf.json) antes de instalar nada:
        // un binario manipulado en transito se rechaza y no se ejecuta.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            check_engine_status,
            check_engine_update,
            check_app_update,
            install_app_update,
            install_dedicated_engine,
            launch_isolated_profile,
            close_profile,
            is_profile_running,
            profile_traffic,
            reset_profile_traffic,
            // Registrados: la UI los invoca en ProfilesView (exportar/importar/
            // limpiar cookies). Antes no estaban en el handler y fallaban con
            // "command not found".
            browser_get_cookies,
            browser_set_cookies,
            browser_clear_cookies,
            create_embedded_browser,
            close_embedded_browser,
            resize_embedded_browser,
            get_hwid,
            test_proxy_connection,
            parse_proxy_string,
            secure_get,
            secure_set,
            secure_delete,
            backend::login,
            backend::register,
            backend::logout,
            backend::get_current_user,
            backend::get_profiles,
            backend::create_profile,
            backend::update_profile_by_id,
            backend::delete_profile,
            backend::update_profile,
            backend::change_password,
            backend::get_sessions,
            backend::start_session,
            backend::stop_session,
            backend::reactivate_session,
            backend::delete_session,
            backend::get_users,
            backend::ban_user,
            backend::delete_user,
            backend::change_plan,
            backend::reset_password,
            backend::reset_hwid,
            backend::assign_role,
            backend::get_keys,
            backend::create_key,
            backend::revoke_key,
            backend::delete_key,
            backend::get_analytics,
            backend::get_activity,
            backend::export_backup,
            backend::purge_sessions,
            api::server_login,
            api::server_register,
            api::server_get_current_user,
            api::server_refresh_ticket,
            api::server_redeem_key,
            api::server_logout,
            api::server_users_list,
            api::server_ban_user,
            api::server_delete_user,
            api::server_assign_role,
            api::server_change_plan,
            api::server_reset_password,
            api::server_reset_hwid,
            api::server_keys_list,
            api::server_mint_keys,
            api::server_revoke_key,
            api::server_delete_key,
            api::server_get_analytics,
            api::server_get_activity,
            // Existían solo en el fallback web de tauriBridge.ts: en escritorio
            // "Exportar datos", "Purgar sesiones" y el uso del plan fallaban
            // con "command not found".
            api::server_export_backup,
            api::server_purge_sessions,
            api::server_membership_usage,
            api::server_update_profile,
            api::server_change_password,
            api::server_profiles_list,
            api::server_profiles_tags,
            api::server_fingerprint,
            api::server_create_profile,
            api::server_update_profile_by_id,
            api::server_delete_profile,
            api::server_sessions_list,
            api::server_start_session,
            api::server_create_session,
            api::server_stop_session,
            api::server_reactivate_session,
            api::server_delete_session,
            api::server_get_dashboard,
            api::server_get_public_content,
            api::server_content_admin_get,
            api::server_content_preview,
            api::server_content_publish,
            api::server_content_history,
            api::server_content_revert,
            hardware::get_hardware_info,
            guard::get_guard_status,
        ])
        .setup(|app| {
            #[cfg(desktop)]
            {
                use tauri::Manager;
                const ICON_BYTES: &[u8] = include_bytes!("../icons/128x128.png");
                if let Ok(icon) = tauri::image::Image::from_bytes(ICON_BYTES) {
                    for (_label, win) in app.webview_windows() {
                        let _ = win.set_icon(icon.clone());
                    }
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
