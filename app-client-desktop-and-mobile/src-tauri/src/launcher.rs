use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::{LazyLock, Mutex};
use tauri::State;

/// Major del motor Chromium que se distribuye con la app.
///
/// Decisión de producto (2026-09-29): la app SIEMPRE usa su propio motor, nunca
/// el Chrome del sistema. El motor se fija a una versión concreta y la UA se
/// deriva de ella, de modo que la versión anunciada y la versión real del binario
/// (y por tanto su firma TLS/JA3 y su HTTP/2 fingerprint) son la misma.
///
/// Desde el 26-oct-2026 el motor es ungoogled-chromium (misma base Chromium,
/// sin los servicios de Google: menos procesos y menos RAM, ~0.5 GB menos
/// recreados en pruebas A/B con PixelScan y CreepJS). Especifica el major
/// contra la referencia de mercado: Chrome 156 sale estable el 2026-10-20;
/// el manifiesto de Chrome for Testing sigue siendo la referencia de versión
/// exacta porque ungoogled publica la misma build el mismo día.
pub const ENGINE_MAJOR: u32 = 156;

/// Fichero de manifiesto que escribe el instalador del motor junto al binario.
/// Es la fuente de verdad de la versión: evita lanzar un subproceso por sesión
/// para preguntarle la versión a Chrome.
const ENGINE_MANIFEST: &str = "engine.json";

/// Major REAL del motor instalado. Sin valor de reserva: si el manifiesto falta
/// o está corrupto se devuelve un error, porque anunciar una versión distinta de
/// la del binario es exactamente la fuga que este módulo evita.
pub fn browser_major_version() -> Result<u32, String> {
    static MAJOR: LazyLock<Result<u32, String>> = LazyLock::new(|| {
        let manifest = get_target_engine_install_dir().join(ENGINE_MANIFEST);
        let text = std::fs::read_to_string(&manifest).map_err(|e| {
            format!(
                "No se encontró el manifiesto del motor en {}. \
                 Instala el motor desde Configuración -> Motor de Navegación. ({})",
                manifest.display(),
                e
            )
        })?;
        let v: serde_json::Value = serde_json::from_str(&text)
            .map_err(|e| format!("Manifiesto del motor corrupto ({}): {}", manifest.display(), e))?;
        let major = v
            .get("major")
            .and_then(|m| m.as_u64())
            .ok_or_else(|| format!("El manifiesto del motor no declara 'major': {}", manifest.display()))?;
        Ok(major as u32)
    });
    MAJOR.clone()
}

/// Versión completa del motor instalado, p.ej. "154.0.8113.86". Se usa para
/// construir `fullVersionList` de los Client Hints.
pub fn browser_full_version() -> Result<String, String> {
    static FULL: LazyLock<Result<String, String>> = LazyLock::new(|| {
        let manifest = get_target_engine_install_dir().join(ENGINE_MANIFEST);
        let text = std::fs::read_to_string(&manifest)
            .map_err(|e| format!("Manifiesto del motor no disponible ({}): {}", manifest.display(), e))?;
        let v: serde_json::Value = serde_json::from_str(&text)
            .map_err(|e| format!("Manifiesto del motor corrupto: {}", e))?;
        v.get("version")
            .and_then(|s| s.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| "El manifiesto del motor no declara 'version'".to_string())
    });
    FULL.clone()
}

/// Extrae el major de una cadena de versión tipo "154.0.8113.86" o
/// "Google Chrome 154.0.8113.86". Devuelve None si no hay un número plausible.
/// Se usa para validar el binario descargado contra el manifiesto.
pub fn parse_chrome_major(text: &str) -> Option<u32> {
    for token in text.split(|c: char| !(c.is_ascii_digit() || c == '.')) {
        if token.is_empty() {
            continue;
        }
        let major_str = token.split('.').next().unwrap_or("");
        if let Ok(major) = major_str.parse::<u32>() {
            // Chrome va por 1xx; descartamos numeros sueltos (años, pids...).
            if (100..=200).contains(&major) {
                return Some(major);
            }
        }
    }
    None
}

/// Cliente HTTP propio del módulo: el motor se instala una vez y no debe
/// arrastrar la sesión autenticada del backend.
fn engine_http() -> &'static reqwest::Client {
    static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .user_agent(format!("{}/{}", crate::brand::APP_NAME, env!("CARGO_PKG_VERSION")))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    });
    &CLIENT
}

/// Consulta el manifiesto oficial de Chrome for Testing y devuelve la build
/// exacta del major pedido. Así se recogen los parches de seguridad del major
/// (Chrome ahora publica un major cada 2 semanas) sin tocar el código.
pub async fn resolve_engine_build(major: u32) -> Result<String, String> {
    const MANIFEST_URL: &str =
        "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json";

    let resp = engine_http()
        .get(MANIFEST_URL)
        .send()
        .await
        .map_err(|e| format!("No se pudo consultar el manifiesto de Chrome for Testing: {}", e))?
        .json::<serde_json::Value>()
        .await
        .map_err(|e| format!("Manifiesto de Chrome for Testing ilegible: {}", e))?;

    // Estructura: { channels: { Stable: { version, downloads: { chrome: [ {platform,url} ] } } }, ... }
    // Se recorre TODO el manifiesto buscando el major pedido: la versión
    // "estable" global puede ser un major distinto al fijado.
    let channels = resp
        .get("channels")
        .and_then(|c| c.as_object())
        .ok_or("Manifiesto de Chrome for Testing con formato inesperado (channels)")?;

    for chan in channels.values() {
        let version = match chan.get("version").and_then(|v| v.as_str()) {
            Some(v) => v,
            None => continue,
        };
        if parse_chrome_major(version) != Some(major) {
            continue;
        }
        return Ok(version.to_string());
    }

    Err(format!(
        "El major {} ya no está disponible en Chrome for Testing. \
         Actualiza ENGINE_MAJOR en src-tauri/src/launcher.rs.",
        major
    ))
}

/// Versión estable de Chrome publicada actualmente.
///
/// Es la referencia de mercado: la que tiene la mayoría de usuarios. Sirve para
/// avisar de que `ENGINE_MAJOR` se ha quedado viejo. Desde Chrome 153 (Sept 2026)
/// Google publica un major cada DOS semanas, así que un major fijado se caduca
/// solo, sin que nadie toque el código.
pub async fn latest_stable_build() -> Result<String, String> {
    const MANIFEST_URL: &str =
        "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json";

    let resp = engine_http()
        .get(MANIFEST_URL)
        .send()
        .await
        .map_err(|e| format!("No se pudo consultar el estado de Chrome: {}", e))?
        .json::<serde_json::Value>()
        .await
        .map_err(|e| format!("Manifiesto de Chrome ilegible: {}", e))?;

    // Se prueba primero el canal Estable. Si no viniera, se recorre el resto:
    // durante un rollout Google puede mover el major entre canales.
    let channels = resp.get("channels").and_then(|c| c.as_object());
    if let Some(ch) = channels {
        if let Some(v) = ch.get("Stable").and_then(|s| s.get("version")).and_then(|v| v.as_str()) {
            return Ok(v.to_string());
        }
    }
    if let Some(ch) = channels {
        for (_name, chan) in ch {
            if let Some(v) = chan.get("version").and_then(|v| v.as_str()) {
                if let Some(m) = parse_chrome_major(v) {
                    if m > ENGINE_MAJOR {
                        return Ok(v.to_string());
                    }
                }
            }
        }
    }
    Err("El manifiesto de Chrome no declara ningún canal utilizable".to_string())
}

/// Estado de caducidad del motor instalado frente al Chrome estable actual.
#[derive(Debug, Clone, Serialize)]
pub struct EngineUpdateInfo {
    /// Major fijado en el código (ENGINE_MAJOR).
    pub pinned_major: u32,
    /// Major realmente instalado, si el motor está presente.
    pub installed_major: Option<u32>,
    /// Major estable publicado por Google ahora mismo.
    pub latest_major: Option<u32>,
    /// Hay un major más reciente que el fijado.
    pub update_available: bool,
    /// No se pudo consultar la red: no se puede afirmar nada.
    pub unknown: bool,
}

/// ¿Hay un Chrome estable más reciente que el major fijado?
///
/// `None` = no se pudo consultar (sin red): no se afirma nada, para no generar
/// una falsa alarma.
pub fn engine_is_outdated(pinned: u32, latest: Option<u32>) -> bool {
    matches!(latest, Some(l) if l > pinned)
}

/// Compara el motor instalado con el Chrome estable actual.
///
/// IMPORTANTE: esto NO bloquea el lanzamiento. Un motor antiguo sigue siendo
/// coherente consigo mismo (la UA se deriva de él), sólo que representa con
/// menos fidelidad al parque real de navegadores. Bloquear sería peor:
/// convertir un problema de representatividad en una pérdida de ingresos.
#[tauri::command]
pub async fn check_engine_update() -> EngineUpdateInfo {
    let installed = browser_full_version()
        .ok()
        .and_then(|v| parse_chrome_major(&v));

    let latest = latest_stable_build()
        .await
        .ok()
        .and_then(|v| parse_chrome_major(&v));

    EngineUpdateInfo {
        pinned_major: ENGINE_MAJOR,
        installed_major: installed,
        latest_major: latest,
        update_available: engine_is_outdated(ENGINE_MAJOR, latest),
        unknown: latest.is_none(),
    }
}

/// URL de descarga de la build para la plataforma actual.
///
/// Linux y Windows usan ungoogled-chromium (misma base Chromium sin servicios
/// de Google): Linux se publica como tar.xz y Windows mantuvo el zip. macOS no
/// tiene port de ungoogled publicado, así que ahí sigue el zip de Chrome for
/// Testing: respetar la plataforma y el formato que ya estaba verificado.
pub fn engine_download_url(version: &str) -> String {
    #[cfg(target_os = "windows")]
    {
        format!(
            "https://github.com/ungoogled-software/ungoogled-chromium-windows/releases/download/{}-1.1/ungoogled-chromium_{}-1.1_windows_x64.zip",
            version, version
        )
    }
    #[cfg(target_os = "macos")]
    {
        format!(
            "https://storage.googleapis.com/chrome-for-testing-public/{}/mac-x64/chrome-mac-x64.zip",
            version
        )
    }
    #[cfg(not(target_os = "windows"))]
    #[cfg(not(target_os = "macos"))]
    {
        format!(
            "https://github.com/ungoogled-software/ungoogled-chromium-portablelinux/releases/download/{}-1/ungoogled-chromium-{}-1-x86_64_linux.tar.xz",
            version, version
        )
    }
}

#[cfg(test)]
mod engine_tests {
    use super::*;

    #[test]
    fn parses_chrome_version_strings() {
        assert_eq!(parse_chrome_major("Google Chrome 154.0.8113.86"), Some(154));
        assert_eq!(parse_chrome_major("154.0.8113.86"), Some(154));
        assert_eq!(parse_chrome_major("Chromium 131.0.6778.109 snap"), Some(131));
        // Valores que NO son una versión de Chromium: no deben colarse en la UA.
        assert_eq!(parse_chrome_major("2026"), None);
        assert_eq!(parse_chrome_major(""), None);
        assert_eq!(parse_chrome_major("sin version"), None);
    }

    #[test]
    fn download_url_matches_platform_and_ungoogled_source() {
        let url = engine_download_url("156.0.8078.47");
        // Linux y Windows van por ungoogled-chromium; macOS conserva el zip de
        // Chrome for Testing porque no hay port de ungoogled publicado.
        if cfg!(target_os = "windows") {
            assert!(url.starts_with(
                "https://github.com/ungoogled-software/ungoogled-chromium-windows/releases/download/156.0.8078.47-1.1/"
            ), "url: {}", url);
            assert!(url.ends_with("_windows_x64.zip"), "url: {}", url);
        } else if cfg!(target_os = "macos") {
            assert!(url.starts_with("https://storage.googleapis.com/chrome-for-testing-public/156.0.8078.47/"), "url: {}", url);
            assert!(url.contains("mac-x64"), "url: {}", url);
        } else {
            assert!(url.starts_with(
                "https://github.com/ungoogled-software/ungoogled-chromium-portablelinux/releases/download/156.0.8078.47-1/"
            ), "url: {}", url);
            assert!(url.ends_with("_linux.tar.xz"), "url: {}", url);
        }
    }

    /// Regresión: el motor dedicado era Chrome for Testing 132 (enero de 2025)
    /// y la app anunciaba Chrome 131-133. Debe quedar una sola fuente de verdad.
    #[test]
    fn zombie_state_is_not_alive() {
        assert!(!stat_state_is_alive('Z'));
        assert!(!stat_state_is_alive('X'));
        assert!(!stat_state_is_alive('x'));
        assert!(stat_state_is_alive('S'));
        assert!(stat_state_is_alive('R'));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn current_process_is_alive() {
        assert!(process_is_alive(std::process::id()));
    }

    #[test]
    fn engine_major_is_a_recent_stable_chrome() {
        assert!(
            (150..=160).contains(&ENGINE_MAJOR),
            "el major fijado ({}) deberia ser un Chrome estable reciente, no uno de 2024/2025",
            ENGINE_MAJOR
        );
    }

    /// El major fijado se caduca solo: Chrome publica uno cada 2 semanas desde
    /// el 153 (Sept 2026). Esto no es un fallo del motor, que sigue siendo
    /// coherente consigo mismo, pero reduce qué porcentaje del parque real
    /// representa.
    #[test]
    fn staleness_comparison_is_correct() {
        // Detecta que hay major más nuevo.
        assert!(engine_is_outdated(154, Some(156)));
        assert!(engine_is_outdated(154, Some(155)));
        // No cuando es el mismo.
        assert!(!engine_is_outdated(154, Some(154)));
        // No cuando el fijado va por delante (no debería pasar, pero no debe
        // provocar una falsa alarma).
        assert!(!engine_is_outdated(154, Some(153)));
        // Sin red no se puede afirmar nada: nunca se anuncia una actualización
        // que no se ha podido comprobar.
        assert!(!engine_is_outdated(154, None));
    }
}

/// Lee el major del binario ya instalado, para verificar que coincide con el
/// manifiesto antes de usarlo.
pub fn probe_installed_major(bin: &PathBuf) -> Option<u32> {
    #[cfg(target_os = "windows")]
    {
        // `chrome.exe --version` no imprime nada en Windows: abre la GUI.
        // Se lee el recurso de versión del PE vía PowerShell.
        let ps = format!(
            "(Get-Item -LiteralPath '{}').VersionInfo.ProductVersion",
            bin.display()
        );
        let out = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &ps])
            .output()
            .ok()?;
        parse_chrome_major(&String::from_utf8_lossy(&out.stdout))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let out = Command::new(bin).arg("--version").output().ok()?;
        parse_chrome_major(&String::from_utf8_lossy(&out.stdout))
    }
}

/// Tráfico parásito observado en proxy.log (mtalk = FCM/WebSocket push en
/// :5228; optimizationguide = menu de Chrome). Se bloquean en el resolver de
/// Chromium para que el presupuesto de MB vaya solo a tráfico útil.
const PARASITE_HOSTS: [&str; 2] = ["mtalk.google.com", "optimizationguide-pa.googleapis.com"];

fn parasite_host_resolver_rules() -> String {
    PARASITE_HOSTS
        .iter()
        .map(|h| format!("MAP {} ^NOTFOUND", h))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Alias de familias de fuentes "Microsoft" que usan los probes de
/// fingerprint (creepjs.org, Pixelscan) hacia familias reales instaladas en
/// Linux (Liberation/DejaVu). Chrome/Skia matchea familias de CSS vía
/// fontconfig; sin estos alias el conteo de fuentes queda en 4 y CreepJS lo
/// marca como lie ("Unusually low font count") aunque el sistema tenga otras
/// fuentes instaladas. Es un drop-in en conf.d del usuario: no toca su
/// fonts.conf y es idempotente/reversible.
const FONTCONFIG_ALIASES: &str = r#"<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <alias><family>Verdana</family><prefer><family>DejaVu Sans</family></prefer></alias>
  <alias><family>Georgia</family><prefer><family>Liberation Serif</family></prefer></alias>
  <alias><family>Palatino</family><prefer><family>Liberation Serif</family></prefer></alias>
  <alias><family>Garamond</family><prefer><family>DejaVu Serif</family></prefer></alias>
  <alias><family>Bookman</family><prefer><family>DejaVu Serif</family></prefer></alias>
  <alias><family>Comic Sans MS</family><prefer><family>DejaVu Sans</family></prefer></alias>
  <alias><family>Trebuchet MS</family><prefer><family>DejaVu Sans</family></prefer></alias>
  <alias><family>Impact</family><prefer><family>Liberation Sans</family></prefer></alias>
  <alias><family>Lucida Console</family><prefer><family>Liberation Mono</family></prefer></alias>
  <alias><family>Tahoma</family><prefer><family>DejaVu Sans</family></prefer></alias>
  <alias><family>Lucida Sans Unicode</family><prefer><family>DejaVu Sans</family></prefer></alias>
  <alias><family>Geneva</family><prefer><family>DejaVu Sans</family></prefer></alias>
  <alias><family>Monaco</family><prefer><family>Liberation Mono</family></prefer></alias>
  <alias><family>Andale Mono</family><prefer><family>Liberation Mono</family></prefer></alias>
</fontconfig>"#;

#[cfg(target_os = "linux")]
pub fn ensure_fontconfig_aliases() {
    let home = std::env::var("HOME").unwrap_or_default();
    let xdg = std::env::var("XDG_CONFIG_HOME")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| format!("{}/.config", home));
    let conf_dir = PathBuf::from(xdg).join("fontconfig").join("conf.d");
    if let Err(e) = std::fs::create_dir_all(&conf_dir) {
        eprintln!("[fontconfig] no se pudo crear {}: {}", conf_dir.display(), e);
        return;
    }
    let target = conf_dir.join(format!("99-{}-fonts-aliases.conf", crate::brand::SLUG));
    let current = std::fs::read_to_string(&target).unwrap_or_default();
    if current.trim() != FONTCONFIG_ALIASES.trim() {
        if let Err(e) = std::fs::write(&target, FONTCONFIG_ALIASES) {
            eprintln!("[fontconfig] error escribiendo {}: {}", target.display(), e);
            return;
        }
        let _ = Command::new("fc-cache").arg("-f").output();
    }
}

#[cfg(not(target_os = "linux"))]
pub fn ensure_fontconfig_aliases() {}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LaunchConfig {
    pub profile_id: String,
    pub profile_name: Option<String>,
    pub start_url: Option<String>,
    pub proxy: Option<String>,
    pub user_agent: Option<String>,
    pub os: Option<String>,
    pub screen_width: Option<u32>,
    pub screen_height: Option<u32>,
    pub timezone: Option<String>,
    pub locale: Option<String>,
    pub webrtc_disabled: Option<bool>,
    pub custom_flags: Option<Vec<String>>,
    pub session_id: Option<String>,
    pub proxy_budget_mb: Option<u32>,
    pub startup_urls: Option<Vec<String>>,
    /// Receta de huella ya resuelta por el servidor (POST /api/fingerprint).
    /// Cuando viene, build_identity la aplica en vez de derivar localmente.
    pub fingerprint_json: Option<String>,
    // Coherencia Geográfica (Geo-Coherence Engine)
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub auto_geo_coherence: Option<bool>,
    /// Tamaño lógico del monitor real. Lo rellena launch_isolated_profile desde
    /// la ventana de Tauri: la pantalla emulada nunca puede ser menor que él.
    #[serde(default)]
    pub host_screen_width: Option<u32>,
    #[serde(default)]
    pub host_screen_height: Option<u32>,
}

#[derive(Default)]
pub struct ProcessManager {
    // Mapa de profile_id -> Child process
    pub active_processes: Mutex<HashMap<String, Child>>,
    // Contadores de tráfico por perfil/sesión (bytes y peticiones).
    pub traffic: Mutex<HashMap<String, std::sync::Arc<crate::cdp::TrafficStats>>>,
    // PID del navegador asociado a cada sesión. El monitor de vida lo usa para
    // no cerrar una sesión nueva si el usuario la retoma antes de que el hilo
    // antiguo detecte el cierre del navegador anterior.
    pub session_pids: std::sync::Arc<Mutex<HashMap<String, u32>>>,
}

/// Resuelve la ruta base para perfiles aislados en el sistema operativo.
///
/// `profile_id` viene de la UI por IPC: se valida antes de tocar el disco para
/// impedir escapadas del directorio de datos (path traversal).
pub fn get_profile_dir(profile_id: &str) -> Result<PathBuf, String> {
    let root = crate::paths::data_dir()
        .ok_or_else(|| "No se pudo determinar el directorio de usuario".to_string())?;
    let data_dir = crate::paths::profile_dir(&root.join("profiles"), profile_id)?;

    // Crear el directorio de datos aislado y su subcarpeta Default
    std::fs::create_dir_all(data_dir.join("Default"))
        .map_err(|e| format!("Error creando directorio de perfil: {}", e))?;
    Ok(data_dir)
}

/// Configura las preferencias nativas (Preferences JSON) de Chromium para aislar
/// WebRTC, geolocalización y servicios automáticos sin inyección de JS.
pub fn apply_profile_preferences(profile_dir: &PathBuf, config: &LaunchConfig) {
    let pref_path = profile_dir.join("Default").join("Preferences");
    
    let mut root: serde_json::Value = if pref_path.exists() {
        std::fs::read_to_string(&pref_path)
            .ok()
            .and_then(|content| serde_json::from_str(&content).ok())
            .unwrap_or_else(|| serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    // Políticas de privacidad y WebRTC sin leaks
    let webrtc_policy = if config.webrtc_disabled.unwrap_or(true) {
        "disable_non_proxied_udp"
    } else {
        "default"
    };

    root["webrtc"] = serde_json::json!({
        "ip_handling_policy": webrtc_policy,
        "multiple_routes_enabled": false,
        "nonproxied_udp_enabled": false
    });

    // Desactivar telemetría nativa de Google
    root["safebrowsing"] = serde_json::json!({ "enabled": false });
    root["profile"] = serde_json::json!({
        "content_settings": {
            "exceptions": {
                "notifications": {}
            }
        },
        "default_content_setting_values": {
            "geolocation": 1 // Permitir geolocalización alineada
        },
        "exit_type": "Normal"
    });

    // Idioma a nivel de motor. El shim solo cambiaba navigator.language en la
    // página; los Web Workers leen esta preferencia y devolvían 'es-419' (lo que
    // Chromium deriva de --lang=es-MX) frente a 'es-MX' en la página.
    if let Some(locale) = config.locale.as_deref().map(str::trim).filter(|l| !l.is_empty()) {
        let base = locale.split('-').next().unwrap_or(locale);
        let accept = if base != locale { format!("{},{}", locale, base) } else { locale.to_string() };
        if !root["intl"].is_object() {
            root["intl"] = serde_json::json!({});
        }
        root["intl"]["accept_languages"] = serde_json::json!(accept);
        root["intl"]["selected_languages"] = serde_json::json!(accept);
    }

    let _ = std::fs::write(pref_path, serde_json::to_string_pretty(&root).unwrap_or_default());
}

/// Resuelve la ruta del motor Chromium dedicado de Kraken Ges (aislado y autónomo)
pub fn resolve_dedicated_engine_path() -> Option<PathBuf> {
    // 1. Directorio del ejecutable actual (instalación bundle/portable)
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            #[cfg(target_os = "windows")]
            let local_candidates = [
                exe_dir.join("bin").join("chrome.exe"),
                exe_dir.join("chrome-win64").join("chrome.exe"),
                exe_dir.join("chrome.exe"),
                exe_dir.join("resources").join("bin").join("chrome.exe"),
                exe_dir.join("resources").join("chrome-win64").join("chrome.exe"),
                exe_dir.join("resources").join("bin").join("windows").join("chrome.exe"),
            ];

            #[cfg(not(target_os = "windows"))]
            let local_candidates = [
                exe_dir.join("bin").join("chrome"),
                exe_dir.join("chrome-linux64").join("chrome"),
                exe_dir.join("chrome"),
                exe_dir.join("resources").join("bin").join("chrome"),
                exe_dir.join("resources").join("chrome-linux64").join("chrome"),
                exe_dir.join("resources").join("bin").join("linux").join("chrome"),
            ];

            for p in local_candidates {
                if p.exists() {
                    return Some(p);
                }
            }
        }
    }

    // 2. Variable APPDIR de AppImage (Linux)
    #[cfg(target_os = "linux")]
    if let Ok(appdir) = std::env::var("APPDIR") {
        let appdir_path = PathBuf::from(appdir);
        let candidates = [
            appdir_path.join("bin").join("chrome"),
            appdir_path.join("chrome-linux64").join("chrome"),
            appdir_path.join("usr").join("lib").join(crate::brand::SLUG).join("chrome"),
            appdir_path.join("usr").join("bin").join("chrome"),
            appdir_path.join("chrome"),
        ];
        for p in candidates {
            if p.exists() {
                return Some(p);
            }
        }
    }

    // 3. Directorio de datos del usuario dedicado (instalado por Setup o descargador integrado)
    #[cfg(target_os = "windows")]
    if let Ok(local_appdata) = std::env::var("LOCALAPPDATA") {
        let base = PathBuf::from(&local_appdata).join(crate::brand::APP_NAME);
        let candidates = [
            base.join("engine").join("chrome-win64").join("chrome.exe"),
            base.join("engine").join("chrome.exe"),
            base.join("bin").join("chrome.exe"),
        ];
        for p in candidates {
            if p.exists() {
                return Some(p);
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        if let Ok(home) = std::env::var("HOME") {
            let data_dir = PathBuf::from(&home).join(".local").join("share").join(crate::brand::SLUG);
            let candidates = [
                data_dir.join("engine").join("chrome-linux64").join("chrome"),
                data_dir.join("engine").join("chrome"),
                data_dir.join("bin").join("chrome"),
                PathBuf::from("/opt").join(crate::brand::SLUG).join("bin").join("chrome"),
                PathBuf::from("/opt").join(crate::brand::SLUG).join("chrome"),
            ];
            for p in candidates {
                if p.exists() {
                    return Some(p);
                }
            }
        }
    }

    // 4. Directorio local de desarrollo
    #[cfg(target_os = "windows")]
    let dev_bin = PathBuf::from("bin/windows/chrome.exe");
    #[cfg(not(target_os = "windows"))]
    let dev_bin = PathBuf::from("bin/linux/chrome");
    if dev_bin.exists() {
        return Some(dev_bin);
    }

    None
}

pub fn get_target_engine_install_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Ok(local_appdata) = std::env::var("LOCALAPPDATA") {
            return PathBuf::from(local_appdata).join(crate::brand::APP_NAME).join("engine");
        }
        PathBuf::from(r"C:\").join(crate::brand::APP_NAME).join("engine")
    }

    #[cfg(not(target_os = "windows"))]
    {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home).join(".local").join("share").join(crate::brand::SLUG).join("engine");
        }
        std::env::temp_dir().join(format!("{}-engine", crate::brand::SLUG))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineInfo {
    pub is_dedicated: bool,
    pub path: Option<String>,
    pub installed: bool,
    pub version: String,
    pub platform: String,
}

#[tauri::command]
pub fn check_engine_status() -> EngineInfo {
    let platform = if cfg!(target_os = "windows") { "windows" } else { "linux" };
    match (resolve_dedicated_engine_path(), browser_full_version()) {
        (Some(path), Ok(version)) => EngineInfo {
            is_dedicated: true,
            path: Some(path.to_string_lossy().to_string()),
            installed: true,
            version,
            platform: platform.to_string(),
        },
        (Some(path), Err(_)) => EngineInfo {
            is_dedicated: true,
            path: Some(path.to_string_lossy().to_string()),
            installed: false,
            version: format!(
                "Motor presente pero sin manifiesto (se espera Chrome {})",
                ENGINE_MAJOR
            ),
            platform: platform.to_string(),
        },
        (None, _) => EngineInfo {
            is_dedicated: false,
            path: None,
            installed: false,
            version: format!("No instalado (se requiere Chrome {})", ENGINE_MAJOR),
            platform: platform.to_string(),
        },
    }
}

/// Descarga e instala el motor Chromium que acompaña a la app.
///
/// El major está fijado en `ENGINE_MAJOR`; la build exacta (con sus parches de
/// seguridad) se resuelve contra el manifiesto oficial de Chrome for Testing, de
/// modo que actualizar parches no requiere recompilar.
///
/// Tras instalar se escribe `engine.json` junto al binario. Ese manifiesto es la
/// fuente de verdad de la versión que se anunciará en la UA: si falta, la app no
/// arranca el motor en vez de mentir sobre su versión.
/// Instala el motor de navegación autónomo.
///
/// La descarga se hace en Rust y emite progreso (`engine:progress`) para que la
/// interfaz pueda pintar una barra. Antes se delegaba en `Invoke-WebRequest` o
/// en un script con `curl`+`unzip`: eran subprocesos opacos, Rust solo veía el
/// resultado al final y una descarga de ~130 MB no daba ninguna señal, con lo
/// que la app parecía colgada.
///
/// La descarga va a un `.part` temporal y solo se mueve a su sitio al terminar:
/// si se interrumpe, no queda un motor a medias que luego se lanzaría fallando.
#[tauri::command]
pub async fn install_dedicated_engine(app: tauri::AppHandle) -> Result<String, String> {
    use crate::engine_install::{download_with_progress, extract_tar_xz_stripping_root, extract_zip,
                                EngineProgress,
                                ENGINE_PROGRESS_EVENT};
    use tauri::Emitter;

    let install_dir = get_target_engine_install_dir();
    std::fs::create_dir_all(&install_dir).map_err(|e| {
        format!(
            "No se pudo crear el directorio del motor ({}): {}",
            install_dir.display(),
            e
        )
    })?;

    let version = resolve_engine_build(ENGINE_MAJOR).await?;
    let url = engine_download_url(&version);

    let zip_path = install_dir.join("engine.zip.part");
    let _ = app.emit(
        ENGINE_PROGRESS_EVENT,
        EngineProgress {
            downloaded: 0,
            total: 0,
            url: url.clone(),
            phase: "download".into(),
        },
    );

    download_with_progress(&app, &url, &zip_path).await?;

    // Extraction según el formato que declare la URL: Linux entrega tar.xz
    // (ungoogled-chromium-portablelinux), Windows y macOS zip.
    if url.ends_with(".tar.xz") {
        extract_tar_xz_stripping_root(&zip_path, &install_dir)?;
    } else {
        let _ = app.emit(
            ENGINE_PROGRESS_EVENT,
            EngineProgress {
                downloaded: 0,
                total: 0,
                url: url.clone(),
                phase: "extract".into(),
            },
        );
        extract_zip(&zip_path, &install_dir)?;
    }
    // El temporal se borra solo si todo ha ido bien: si la extracción falla, se
    // conserva para poder reintentar sin volver a bajar 150 MB.
    let _ = std::fs::remove_file(&zip_path);

    // Verificar que el binario existe y que su versión real es la que dice el
    // manifiesto oficial: es exactamente la coherencia que el producto necesita.
    let path = resolve_dedicated_engine_path().ok_or_else(|| {
        format!(
            "El motor {} se descargó pero no se encontró el binario ejecutable.",
            version
        )
    })?;
    if let Some(real) = probe_installed_major(&path) {
        if real != ENGINE_MAJOR {
            return Err(format!(
                "El motor instalado es Chrome {} pero se esperaba Chrome {}. \
                 Borra {} y vuelve a instalar el motor.",
                real,
                ENGINE_MAJOR,
                install_dir.display()
            ));
        }
    }

    // La fuente del motor sale de la URL seleccionada por plataforma, no de una
    // constante, para que si se vuelve a Chrome for Testing (macos) el
    // manifiesto siga describiendo de dónde vino el binario instalado.
    let manifest = json!({
        "version": version,
        "major": ENGINE_MAJOR,
        "source": if url.contains("ungoogled") { "ungoogled-chromium" } else { "chrome-for-testing" },
        "url": url,
    });
    let manifest_path = install_dir.join(ENGINE_MANIFEST);
    std::fs::write(&manifest_path, serde_json::to_string_pretty(&manifest).unwrap_or_default())
        .map_err(|e| format!("No se pudo escribir el manifiesto del motor: {}", e))?;

    let _ = app.emit(
        ENGINE_PROGRESS_EVENT,
        EngineProgress {
            downloaded: 0,
            total: 0,
            url,
            phase: "done".into(),
        },
    );

    Ok(path.to_string_lossy().to_string())
}

/// Binario del motor Chromium que la app ejecuta.
///
/// Decisión de producto (2026-09-29): SOLO el motor propio de Kraken Ges.
///
/// Antes, si el motor dedicado no estaba instalado, se recurría al Chrome /
/// Brave / Edge del sistema. Eso rompía la coherencia de la huella de forma
/// silenciosa: la UA anunciaba Chrome 132-133 (y la del motor dedicado) mientras
/// se ejecutaba el Chrome que tuviera el usuario, que en 2026 es Chrome 15x. La
/// incoherencia se detecta por feature detection y, además, por la firma
/// TLS/JA3 y el HTTP/2 fingerprint, que no se pueden falsificar desde JS.
///
/// Sin motor propio no hay perfil: es preferible negarse a lanzar a lanzar con
/// una huella que se contradice a sí misma.
pub fn resolve_browser_binary() -> Result<PathBuf, String> {
    resolve_dedicated_engine_path().ok_or_else(|| {
        format!(
            "El motor de {} (Chrome {}) no está instalado. \
             Ve a Configuración -> Motor de Navegación e instálalo. \
             No se usa el navegador del sistema a propósito: su versión no \
             coincidiría con la que la app anuncia, y esa incoherencia delata \
             la huella al instante.",
            crate::brand::APP_NAME,
            ENGINE_MAJOR
        )
    })
}

/// Un proceso zombie sigue existiendo para `kill -0`, pero ya no es una ventana
/// viva. Ese detalle hacía que la sesión nunca pasara a "detenida" al cerrar
/// Chrome y el botón "Retomar" no apareciera.
#[allow(dead_code)]
fn stat_state_is_alive(state: char) -> bool {
    !matches!(state, 'Z' | 'X' | 'x')
}

#[cfg(target_os = "linux")]
fn process_is_alive(pid: u32) -> bool {
    let Ok(stat) = std::fs::read_to_string(format!("/proc/{}/stat", pid)) else {
        return false;
    };
    let Some(end) = stat.rfind(')') else {
        return false;
    };
    let Some(state) = stat[end + 1..].trim_start().chars().next() else {
        return false;
    };
    stat_state_is_alive(state)
}

#[cfg(target_os = "macos")]
fn process_is_alive(pid: u32) -> bool {
    let Ok(out) = Command::new("ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
    else {
        return true;
    };
    if !out.status.success() {
        return false;
    }
    String::from_utf8_lossy(&out.stdout)
        .chars()
        .next()
        .map(stat_state_is_alive)
        .unwrap_or(false)
}

#[cfg(windows)]
fn process_is_alive(pid: u32) -> bool {
    let out = Command::new("cmd")
        .args([
            "/C",
            &format!("tasklist /FI \"PID eq {}\" /NH", pid),
        ])
        .output();
    match out {
        Ok(o) => String::from_utf8_lossy(&o.stdout).contains(&pid.to_string()),
        // Si tasklist no está disponible, no se cierra la sesión por error.
        Err(_) => true,
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn process_is_alive(pid: u32) -> bool {
    match Command::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
    {
        Ok(s) => s.success(),
        Err(_) => true,
    }
}

#[tauri::command]
pub fn launch_isolated_profile(
    config: LaunchConfig,
    state: State<'_, ProcessManager>,
    window: tauri::WebviewWindow,
) -> Result<u32, String> {
    let mut config = config;
    if let Ok(Some(monitor)) = window.current_monitor() {
        let size = monitor.size().to_logical::<f64>(monitor.scale_factor());
        config.host_screen_width = Some(size.width.round() as u32);
        config.host_screen_height = Some(size.height.round() as u32);
    }

    const ALREADY_RUNNING: &str = "Este perfil ya tiene una sesión activa. Solo se permite 1 sesión abierta a la vez para proteger cookies y evitar bloqueos de base de datos.";
    let profile_id = config.profile_id.clone();
    let is_running = |processes: &mut HashMap<String, Child>| {
        matches!(processes.get_mut(&profile_id).map(|c| c.try_wait()), Some(Ok(None)))
    };

    // Rechazo rápido del duplicado, sin retener el mutex durante la consulta de
    // red de abajo (hasta ~20 s): mientras tanto close_profile se quedaba
    // esperando.
    if is_running(&mut state.active_processes.lock().unwrap()) {
        return Err(ALREADY_RUNNING.to_string());
    }

    // Token de sesión sticky: sustituir {sess} en la cadena del proveedor
    // (p.ej. "user-res-session-{sess}:pass" => user-res-session-a3f9c1b2).
    // Se calcula ANTES de la geolocalización: con la cadena cruda el proveedor
    // veía otra sesión y la zona horaria salía de otra IP de salida.
    let session_token = config
        .session_id
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| {
            let secs = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            format!("{}-{:02}{:02}{:02}", crate::brand::SLUG, (secs / 3600) % 24, (secs / 60) % 60, secs % 60)
        });
    let cooked_proxy = config
        .proxy
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(|p| p.replace("{sess}", &session_token));

    // ── Geo-Coherence: timezone, idioma y coordenadas = los de la IP de salida ──
    // Con o sin proxy, en CADA lanzamiento. Antes los valores guardados en el
    // perfil ganaban (quedaban viejos al rotar o cambiar de proxy), sin proxy se
    // usaban los del sistema operativo, y si la consulta fallaba se abría con la
    // región de la semilla: tres formas de anunciar un país distinto del de la
    // IP. Solo se respetan los valores del perfil con auto_geo_coherence=false.
    if config.auto_geo_coherence != Some(false) {
        let geo = tauri::async_runtime::block_on(crate::proxy::resolve_egress_geo(cooked_proxy.as_deref()))
            .map_err(|e| {
                format!(
                    "No se pudo verificar la ubicación de la IP de salida{}, así que el perfil no se abrió: \
                     hacerlo anunciaría una zona horaria e idioma que no corresponden a la IP. Detalle: {}",
                    if cooked_proxy.is_some() { " del proxy" } else { "" },
                    e
                )
            })?;
        eprintln!(
            "[Geo-Coherence] IP {:?} ({:?}) => Timezone {}, Lang {}, Coords ({:?}, {:?})",
            geo.ip, geo.country_code, geo.timezone, geo.language, geo.latitude, geo.longitude
        );
        config.timezone = Some(geo.timezone);
        config.locale = Some(geo.language);
        config.latitude = geo.latitude;
        config.longitude = geo.longitude;
    } else if let Some(locale) = config.locale.as_mut() {
        // Perfiles guardados con la lista completa ("es-MX,es;q=0.9"): el locale
        // es solo la primera etiqueta.
        *locale = locale.split([',', ';']).next().unwrap_or("").trim().to_string();
    }

    // La UA guardada en el perfil gana sobre la compuesta (cdp.rs), pero su
    // versión la impone el motor: una UA Chrome/151 sobre un binario 156 es
    // una incoherencia que se ve en TLS, HTTP/2 y feature detection.
    let engine_major = browser_full_version()
        .ok()
        .and_then(|v| crate::pools::pick_chrome_major(&v))
        .unwrap_or(crate::pools::DEFAULT_MAJOR);
    // El SO también es siempre el del host (ver cdp::host_os_key). Una UA
    // guardada de otro sistema se descarta: la UA compuesta sale del catálogo
    // del SO real con el mismo seed.
    let host_os = crate::cdp::host_os_key();
    config.os = Some(host_os.to_string());
    if config
        .user_agent
        .as_deref()
        .is_some_and(|ua| crate::pools::ua_os_key(ua) != Some(host_os))
    {
        eprintln!("[Coherencia] UA guardada de otro SO descartada; se anuncia {}", host_os);
        config.user_agent = None;
    }
    if let Some(ua) = config.user_agent.as_mut() {
        *ua = crate::pools::align_ua_to_engine(ua.trim(), engine_major);
    }

    let mut processes = state.active_processes.lock().unwrap();
    if is_running(&mut processes) {
        return Err(ALREADY_RUNNING.to_string());
    }

    let binary = resolve_browser_binary()?;
    let user_data_dir = get_profile_dir(&config.profile_id)?;

    // Asegurar aliases de fuentes (para la coherencia del fingerprint de fuentes)
    ensure_fontconfig_aliases();

    // Aplicar preferencias persistentes nativas al perfil
    apply_profile_preferences(&user_data_dir, &config);

    let mut cmd = Command::new(&binary);

    // Contadores de tráfico compartidos (CDP + conector ProxyShield).
    let stats = std::sync::Arc::new(crate::cdp::TrafficStats::new());

    cmd.arg(format!("--user-data-dir={}", user_data_dir.display()));
    cmd.arg("--no-first-run");
    cmd.arg("--no-default-browser-check");
    cmd.arg("--disable-sync");
    cmd.arg("--no-service-autorun");
    cmd.arg("--remote-debugging-port=0");
    // SIN --remote-allow-origins. Con `=*` cualquier página abierta en cualquier
    // navegador del equipo podía abrir un WebSocket al puerto CDP (lo encuentra
    // escaneando 127.0.0.1) y controlar el perfil entero: cookies incluidas.
    // Chrome solo comprueba la cabecera Origin, que mandan los navegadores y no
    // tungstenite, así que el inyector sigue conectando. Comprobado con el motor
    // 156: sin Origin -> 101; Origin https://... o null -> 403.
    cmd.arg("--disable-blink-features=AutomationControlled");
    cmd.arg("--disable-infobars");

    // ProxyShield: conecta credenciales y sesiones sticky sin depender de
    // URI-con-credenciales (rechazado en Chromium >= 137) ni extensiones MV2.
    if let Some(cooked) = &cooked_proxy {
        let trimmed_proxy = cooked.as_str();
        {
            if let Ok(parsed) = crate::proxy::parse_proxy(cooked) {
                if parsed.username.is_some() {
                    // Conector local autenticado: Chromium <- 127.0.0.1:<puerto>.
                    match crate::proxy::spawn_shield(&parsed, stats.clone()) {
                        Ok(shield) => {
                            cmd.arg(format!("--proxy-server={}", shield.local_server()));
                            cmd.arg(format!(
                                "--host-resolver-rules={}",
                                parasite_host_resolver_rules()
                            ));
                            eprintln!("[ProxyShield] sesión {} -> {}:{}", session_token, parsed.host, parsed.port);
                        }
                        Err(e) => {
                            return Err(format!("ProxyShield: no se pudo levantar el conector de proxy: {}", e));
                        }
                    }
                } else {
                    cmd.arg(format!("--proxy-server={}", parsed.to_chromium_server()));
                    cmd.arg(format!(
                        "--host-resolver-rules={}",
                        parasite_host_resolver_rules()
                    ));
                }
            } else {
                cmd.arg(format!("--proxy-server={}", trimmed_proxy));
                cmd.arg(format!(
                    "--host-resolver-rules={}",
                    parasite_host_resolver_rules()
                ));
            }
        }
    }

    // WebRTC Leak Protection
    if config.webrtc_disabled.unwrap_or(true) {
        cmd.arg("--force-webrtc-ip-handling-policy=disable_non_proxied_udp");
        cmd.arg("--enforce-webrtc-ip-permission-check");
    }

    if let Some(ua) = &config.user_agent {
        if !ua.trim().is_empty() {
            cmd.arg(format!("--user-agent={}", ua));
        }
    }

    if let (Some(w), Some(h)) = (config.screen_width, config.screen_height) {
        cmd.arg(format!("--window-size={},{}", w, h));
    } else {
        cmd.arg("--start-maximized");
    }

    if let Some(locale) = &config.locale {
        if !locale.trim().is_empty() {
            cmd.arg(format!("--lang={}", locale));
        }
    }

    if let Some(tz) = &config.timezone {
        if !tz.trim().is_empty() {
            cmd.env("TZ", tz);
        }
    }

    if let Some(flags) = &config.custom_flags {
        for flag in flags {
            cmd.arg(flag);
        }
    }

    if let Some(urls) = &config.startup_urls {
        for u in urls {
            if !u.trim().is_empty() {
                cmd.arg(u.trim());
            }
        }
    } else {
        let initial_url = config.start_url.as_deref().unwrap_or("https://pixelscan.net/");
        cmd.arg(initial_url);
    }

    // Eliminar un DevToolsActivePort stale (de una sesión anterior) para que Chrome
    // reescriba el puerto real de ESTA instancia. Si no, el inyector puede leer un
    // puerto muerto del archivo viejo y conectarse a la instancia equivocada.
    let _ = std::fs::remove_file(user_data_dir.join("DevToolsActivePort"));

    // Lanzar el proceso desacoplado
    match cmd.spawn() {
        Ok(child) => {
            let pid = child.id();
            processes.insert(config.profile_id.clone(), child);

            // Motor de huellas CDP: identidad coherente + ruido de canvas por perfil.
            let identity = crate::cdp::build_identity(&config);
            state.traffic.lock().unwrap().insert(config.profile_id.clone(), stats.clone());
            crate::cdp::spawn_fingerprint_injector(user_data_dir.clone(), identity, stats.clone());

            // Presupuesto de datos por sesión: al agotarse, se cierra el perfil.
            if let Some(budget_mb) = config.proxy_budget_mb {
                if budget_mb > 0 {
                    let pid2 = pid;
                    let st2 = stats.clone();
                    let profile_id2 = config.profile_id.clone();
                    std::thread::spawn(move || {
                        let cap = budget_mb as u64 * 1024 * 1024;
                        loop {
                            std::thread::sleep(std::time::Duration::from_millis(1500));
                            let (bytes, _) = st2.snapshot();
                            if bytes >= cap {
                                eprintln!("[ProxyShield] presupuesto {}MB agotado ({:.2}MB) -> cerrando {}", budget_mb, bytes as f64 / 1048576.0, profile_id2);
                                let cmd = if cfg!(windows) { "taskkill" } else { "kill" };
                                let mut args = vec![pid2.to_string()];
                                if cfg!(windows) {
                                    args = vec!["/PID".to_string(), pid2.to_string(), "/F".to_string()];
                                }
                                let _ = std::process::Command::new(cmd).args(args).status();
                                break;
                            }
                        }
                    });
                }
            }

            // Monitor de vida de sesión en segundo plano: al cerrarse la ventana del navegador,
            // se notifica automáticamente al servidor para cerrar la sesión activa.
            if let Some(session_id) = config.session_id.clone() {
                if !session_id.trim().is_empty() {
                    let pid_check = pid;
                    let session_pids = state.session_pids.clone();
                    session_pids.lock().unwrap().insert(session_id.clone(), pid_check);
                    std::thread::spawn(move || {
                        loop {
                            std::thread::sleep(std::time::Duration::from_millis(2000));

                            // Si otra ejecución del mismo perfil ya tomó esta
                            // sesión, este hilo es obsoleto y no debe pararla.
                            let current_pid = session_pids
                                .lock()
                                .unwrap()
                                .get(&session_id)
                                .copied();
                            if current_pid != Some(pid_check) {
                                break;
                            }

                            if !process_is_alive(pid_check) {
                                // Segunda comprobación: el usuario pudo retomar
                                // la sesión mientras detectábamos el cierre.
                                let still_current = session_pids
                                    .lock()
                                    .unwrap()
                                    .get(&session_id)
                                    .copied()
                                    == Some(pid_check);
                                if !still_current {
                                    break;
                                }
                                if let Err(e) = tauri::async_runtime::block_on(async {
                                    crate::api::server_stop_session(session_id.clone()).await
                                }) {
                                    eprintln!(
                                        "[SessionMonitor] no se pudo cerrar la sesión {}: {}",
                                        session_id, e
                                    );
                                }
                                session_pids.lock().unwrap().remove(&session_id);
                                break;
                            }
                        }
                    });
                }
            }

            Ok(pid)
        }
        Err(e) => Err(format!("Error al iniciar el navegador antidetect: {}", e)),
    }
}

#[tauri::command]
pub fn close_profile(profile_id: String, state: State<'_, ProcessManager>) -> Result<bool, String> {
    let mut processes = state.active_processes.lock().unwrap();
    if let Some(mut child) = processes.remove(&profile_id) {
        let _ = child.kill();
        // Recolectar el hijo evita dejar un zombie que `kill -0` seguiría
        // viendo como vivo.
        let _ = child.wait();
        return Ok(true);
    }
    Ok(false)
}

#[tauri::command]
pub fn is_profile_running(profile_id: String, state: State<'_, ProcessManager>) -> Result<bool, String> {
    let mut processes = state.active_processes.lock().unwrap();
    if let Some(child) = processes.get_mut(&profile_id) {
        match child.try_wait() {
            Ok(None) => Ok(true),
            Ok(Some(_)) => {
                processes.remove(&profile_id);
                Ok(false)
            }
            Err(_) => {
                processes.remove(&profile_id);
                Ok(false)
            }
        }
    } else {
        Ok(false)
    }
}

#[tauri::command]
pub fn profile_traffic(profile_id: String, state: State<'_, ProcessManager>) -> Result<(u64, u64), String> {
    let map = state.traffic.lock().unwrap();
    match map.get(&profile_id) {
        Some(stats) => Ok(stats.snapshot()),
        None => Err("Sin métricas de tráfico para este perfil".to_string()),
    }
}

#[tauri::command]
pub fn reset_profile_traffic(profile_id: String, state: State<'_, ProcessManager>) -> Result<(), String> {
    let mut map = state.traffic.lock().unwrap();
    map.remove(&profile_id);
    Ok(())
}

/// Gestión de cookies vía CDP del proceso activo del perfil.

fn devtools_port(user_data_dir: &std::path::Path) -> Result<u16, String> {
    let content = std::fs::read_to_string(user_data_dir.join("DevToolsActivePort"))
        .map_err(|_| "El perfil no tiene una ventana del navegador abierta en este momento.".to_string())?;
    let port: u16 = content
        .lines()
        .next()
        .ok_or_else(|| "DevToolsActivePort vacío (¿navegador iniciándose?).".to_string())?
        .trim()
        .parse()
        .map_err(|_| "Puerto CDP inválido en DevToolsActivePort.".to_string())?;
    if port == 0 {
        return Err("El perfil no tiene un navegador activo.".to_string());
    }
    Ok(port)
}

fn fetch_cdp_json(port: u16, path: &str) -> Result<Value, String> {
    let url = format!("http://127.0.0.1:{}{}", port, path);
    let rt = cdp_runtime();
    let response = rt.block_on(reqwest::get(&url)).map_err(|e| format!("CDP GET {}: {}", path, e))?;
    let text = rt.block_on(response.text()).map_err(|e| format!("CDP body: {}", e))?;
    serde_json::from_str(&text).map_err(|e| format!("CDP JSON {}: {}", path, e))
}

/// Runtime tokio compartido para el CDP local. Antes se creaba un Runtime nuevo
/// (con sus worker threads) en cada llamada a fetch_cdp_json.
fn cdp_runtime() -> &'static tokio::runtime::Runtime {
    static RT: LazyLock<tokio::runtime::Runtime> = LazyLock::new(|| {
        tokio::runtime::Runtime::new().expect("tokio runtime CDP")
    });
    &RT
}

fn page_ws_url(port: u16) -> Result<String, String> {
    let list = fetch_cdp_json(port, "/json/list")?;
    let targets = list.as_array().ok_or_else(|| "Lista de targets CDP inválida.".to_string())?;
    for t in targets {
        if t.get("type").and_then(|v| v.as_str()) == Some("page") {
            if let Some(u) = t.get("webSocketDebuggerUrl").and_then(|v| v.as_str()) {
                return Ok(u.to_string());
            }
        }
    }
    for t in targets {
        if let Some(u) = t.get("webSocketDebuggerUrl").and_then(|v| v.as_str()) {
            return Ok(u.to_string());
        }
    }
    Err("El perfil no tiene ningún target de página para operar cookies.".to_string())
}

/// Websocket del propio navegador (no de una página), y su contexto por defecto.
///
/// Es la vía fiable para leer cookies: `Storage.getCookies` a nivel de navegador
/// devuelve todo el contexto, sin depender de qué pestaña esté abierta. Leer
/// desde un target de página con `Network.getAllCookies` depende de que ese
/// target exista y tenga el contexto esperado, y devuelve vacío si no.
fn browser_ws_url(port: u16) -> Result<String, String> {
    let version = fetch_cdp_json(port, "/json/version")?;
    version
        .get("webSocketDebuggerUrl")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "El navegador no expone su websocket de depuración.".to_string())
}

/// Envía un comando CDP por el websocket del navegador y espera su respuesta.
///
/// `browser_context_id` se omite (null) para el contexto por defecto, que es el
/// del perfil.
fn browser_cdp_call(
    ws_url: &str,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::time::Duration;

    // tungstenite no acepta un timeout de lectura, así que se pone el socket en
    // no-bloqueante con un deadline manual. Sin esto, un navegador que no
    // contesta deja el comando colgado para siempre y la UI se queda cargando.
    let addr = ws_url
        .trim_start_matches("ws://")
        .split('/')
        .next()
        .ok_or_else(|| "Websocket CDP inválido.".to_string())?;
    let stream = TcpStream::connect(addr).map_err(|e| format!("No se pudo conectar al CDP: {}", e))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|e| format!("No se pudo configurar el socket CDP: {}", e))?;

    let (mut socket, _resp) = tungstenite::connect(ws_url)
        .map_err(|e| format!("No se pudo abrir el websocket CDP: {}", e))?;

    let cmd = json!({"id": 1, "method": method, "params": params});
    socket
        .send(tungstenite::Message::Text(cmd.to_string().into()))
        .map_err(|e| format!("No se pudo enviar {}: {}", method, e))?;

    let deadline = std::time::Instant::now() + Duration::from_secs(8);
    loop {
        if std::time::Instant::now() > deadline {
            return Err(format!("El navegador no respondió a {} (8 s).", method));
        }
        match socket.read() {
            Ok(tungstenite::Message::Text(t)) => {
                if let Ok(v) = serde_json::from_str::<Value>(&t) {
                    if v.get("id").and_then(|i| i.as_u64()) == Some(1) {
                        if let Some(err) = v.get("error") {
                            return Err(format!("{}: {}", method, err));
                        }
                        return Ok(v.get("result").cloned().unwrap_or(Value::Null));
                    }
                }
            }
            Ok(_) => continue,
            Err(tungstenite::Error::Io(e))
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(format!("Error leyendo la respuesta CDP: {}", e)),
        }
    }
}

fn cdp_enable_network(
    socket: &mut tungstenite::protocol::WebSocket<tungstenite::stream::MaybeTlsStream<std::net::TcpStream>>,
) -> Result<(), String> {
    socket
        .send(tungstenite::Message::Text(r#"{"id":1,"method":"Network.enable"}"#.into()))
        .map_err(|e| format!("CDP send: {}", e))?;
    loop {
        let msg = socket.read().map_err(|e| format!("CDP read: {}", e))?;
        if let tungstenite::Message::Text(t) = msg {
            if let Ok(v) = serde_json::from_str::<Value>(&t) {
                if v.get("id").and_then(|i| i.as_u64()) == Some(1) {
                    return Ok(());
                }
            }
        }
    }
}

/// Formato "EditThisCookie" para que el frontend detecte la plataforma por dominio.
fn cookie_to_export(c: &Value) -> Value {
    let o = c.as_object().cloned().unwrap_or_default();
    let expires: Option<f64> = o.get("expires").and_then(|e| e.as_f64());
    json!({
        "domain": o.get("domain").cloned().unwrap_or(Value::Null),
        "name": o.get("name").cloned().unwrap_or(Value::Null),
        "value": o.get("value").cloned().unwrap_or(Value::Null),
        "path": o.get("path").cloned().unwrap_or(json!("/")),
        "expirationDate": expires.unwrap_or(4102444800.0),
        "httpOnly": o.get("httpOnly").cloned().unwrap_or(json!(false)),
        "secure": o.get("secure").cloned().unwrap_or(json!(false)),
        "sameSite": o.get("sameSite").cloned().unwrap_or(Value::Null),
    })
}

/// Convierte una cookie del frontend a parámetro Network.CookieParam de CDP.
fn cdp_cookie_param(c: &Value) -> Value {
    let o = c.as_object().cloned().unwrap_or_default();
    let mut p = serde_json::Map::new();
    for k in ["name", "value", "domain", "path"] {
        if let Some(v) = o.get(k) {
            p.insert(k.to_string(), v.clone());
        }
    }
    if let Some(u) = o.get("url") {
        p.insert("url".to_string(), u.clone());
    }
    if let Some(exp) = o.get("expirationDate").and_then(|e| e.as_f64()) {
        p.insert("expires".to_string(), json!(exp.floor() as i64));
    } else if let Some(e) = o.get("expires") {
        p.insert("expires".to_string(), e.clone());
    }
    for k in ["httpOnly", "secure"] {
        if let Some(v) = o.get(k) {
            p.insert(k.to_string(), v.clone());
        }
    }
    if let Some(s) = o.get("sameSite").and_then(|v| v.as_str()) {
        let norm = if s.eq_ignore_ascii_case("no_restriction") || s.eq_ignore_ascii_case("none") {
            "None"
        } else if s.eq_ignore_ascii_case("lax") {
            "Lax"
        } else if s.eq_ignore_ascii_case("strict") {
            "Strict"
        } else {
            "Lax"
        };
        p.insert("sameSite".to_string(), json!(norm));
    }
    Value::Object(p)
}

/// Lee todas las cookies del contexto del perfil.
///
/// Vía principal: `Storage.getCookies` sobre el websocket del NAVEGADOR, que
/// devuelve el contexto completo y no depende de qué pestaña esté abierta.
///
/// Antes solo se usaba `Network.getAllCookies` contra el target de la primera
/// página. Eso es frágil: si ese target no está, o es una página de servicio
/// interna en lugar de la que el usuario está navegando, el resultado llega
/// vacío aunque el navegador tenga las cookies. Se mantiene como respaldo por
/// si el websocket de navegador no está disponible.
fn cdp_get_cookies(port: u16) -> Result<Vec<Value>, String> {
    if let Ok(ws) = browser_ws_url(port) {
        match browser_cdp_call(&ws, "Storage.getCookies", json!({})) {
            Ok(result) => {
                if let Some(arr) = result.get("cookies").and_then(|c| c.as_array()) {
                    return Ok(arr.iter().map(cookie_to_export).collect());
                }
            }
            Err(e) => {
                eprintln!("[cookies] Storage.getCookies falló, se intenta el respaldo: {}", e);
            }
        }
    }

    // Respaldo: la vía antigua por target de página.
    let url = page_ws_url(port)?;
    let (mut socket, _response) =
        tungstenite::connect(&url).map_err(|e| format!("CDP connect: {}", e))?;
    cdp_enable_network(&mut socket)?;
    socket
        .send(
            tungstenite::Message::Text(
                json!({"id":2,"method":"Network.getAllCookies"}).to_string().into(),
            ),
        )
        .map_err(|e| format!("CDP send: {}", e))?;
    loop {
        let msg = socket.read().map_err(|e| format!("CDP read: {}", e))?;
        if let tungstenite::Message::Text(t) = msg {
            if let Ok(v) = serde_json::from_str::<Value>(&t) {
                if let Some(Some(2u64)) = v.get("id").map(|i| i.as_u64()) {
                    let cookies = v
                        .pointer("/result/cookies")
                        .and_then(|c| c.as_array())
                        .cloned()
                        .unwrap_or_default();
                    return Ok(cookies.iter().map(cookie_to_export).collect());
                }
            }
        }
    }
}

fn cdp_set_cookies(ws_url: &str, cookies: &[Value]) -> Result<usize, String> {
    let (mut socket, _response) = tungstenite::connect(ws_url).map_err(|e| format!("CDP connect: {}", e))?;
    cdp_enable_network(&mut socket)?;
    let mut id: u64 = 2;
    let mut count: usize = 0;
    for chunk in cookies.chunks(50) {
        let params: Vec<Value> = chunk.iter().map(cdp_cookie_param).collect();
        let cmd = json!({"id": id, "method": "Network.setCookies", "params": {"cookies": params}});
        socket
            .send(tungstenite::Message::Text(cmd.to_string().into()))
            .map_err(|e| format!("CDP send: {}", e))?;
        loop {
            let msg = socket.read().map_err(|e| format!("CDP read: {}", e))?;
            if let tungstenite::Message::Text(t) = msg {
                if let Ok(v) = serde_json::from_str::<Value>(&t) {
                    if v.get("id").and_then(|i| i.as_u64()) == Some(id) {
                        if let Some(err) = v.get("error") {
                            return Err(format!("CDP setCookies: {}", err));
                        }
                        break;
                    }
                }
            }
        }
        count += chunk.len();
        id += 1;
    }
    Ok(count)
}

fn cdp_clear_cookies(ws_url: &str) -> Result<(), String> {
    let (mut socket, _response) = tungstenite::connect(ws_url).map_err(|e| format!("CDP connect: {}", e))?;
    cdp_enable_network(&mut socket)?;
    socket
        .send(tungstenite::Message::Text(json!({"id":2,"method":"Network.clearBrowserCookies"}).to_string().into()))
        .map_err(|e| format!("CDP send: {}", e))?;
    loop {
        let msg = socket.read().map_err(|e| format!("CDP read: {}", e))?;
        if let tungstenite::Message::Text(t) = msg {
            if let Ok(v) = serde_json::from_str::<Value>(&t) {
                if let Some(Some(2u64)) = v.get("id").map(|i| i.as_u64()) {
                    if let Some(err) = v.get("error") {
                        return Err(format!("CDP clearBrowserCookies: {}", err));
                    }
                    return Ok(());
                }
            }
        }
    }
}

#[tauri::command]
pub fn browser_get_cookies(profile_id: String) -> Result<Value, String> {
    let dir = get_profile_dir(&profile_id)?;
    let port = devtools_port(&dir)?;
    let cookies = cdp_get_cookies(port)?;
    Ok(json!({ "success": true, "cookies": cookies, "count": cookies.len() }))
}

#[tauri::command]
pub fn browser_set_cookies(profile_id: String, cookies: Vec<Value>) -> Result<Value, String> {
    let dir = get_profile_dir(&profile_id)?;
    let port = devtools_port(&dir)?;
    let url = page_ws_url(port)?;
    let count = cdp_set_cookies(&url, &cookies)?;
    Ok(json!({ "success": true, "count": count }))
}

#[tauri::command]
pub fn browser_clear_cookies(profile_id: String) -> Result<Value, String> {
    let dir = get_profile_dir(&profile_id)?;
    let port = devtools_port(&dir)?;
    let url = page_ws_url(port)?;
    cdp_clear_cookies(&url)?;
    Ok(json!({ "success": true }))
}
