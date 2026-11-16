use crate::launcher::LaunchConfig;
use serde::Deserialize;
use serde_json::json;
use std::path::PathBuf;
use std::sync::LazyLock;
use std::thread;
use std::time::{Duration, Instant};
use tungstenite::{connect, Message};

/// Tipo de socket que devuelve `tungstenite::connect`.
///
/// Desde tungstenite 0.24 la conexion CDP a 127.0.0.1 no es un `WebSocket<S>`
/// parametrico sino `WebSocket<MaybeTlsStream<TcpStream>>`: aunque el endpoint
/// sea `ws://` sin TLS, la libreria lo normaliza a MaybeTlsStream.
pub type CdpWs = tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<std::net::TcpStream>>;

/// Receta de identidad dictada por el servidor (POST /api/fingerprint).
/// El cliente se limita a aplicarla; nunca la deriva localmente cuando existe.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerFingerprint {
    pub seed: u32,
    #[serde(rename = "os")]
    pub os_key: String,
    pub identity: ServerFingerprintIdentity,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerFingerprintIdentity {
    pub kit_id: String,
    pub full_version: String,
    pub major: u32,
    pub platform: String,
    pub ua_os: String,
    pub platform_version: String,
    pub screen_width: u32,
    pub screen_height: u32,
    pub device_pixel_ratio: f64,
    pub device_memory: f64,
    pub cores: u8,
    pub timezone: String,
    pub language: String,
}

/// Identidad coherente que sigue un perfil concreto. Solo los campos presentes
/// se inyectan: nunca se miente sobre valores que no tenemos certificados.
#[derive(Debug, Clone, Default)]
pub struct FingerprintIdentity {
    pub user_agent: Option<String>,
    pub platform: Option<String>,
    pub vendor: Option<String>,
    pub screen_width: Option<u32>,
    pub screen_height: Option<u32>,
    pub device_pixel_ratio: Option<f64>,
    pub hardware_concurrency: Option<u8>,
    pub device_memory: Option<f64>,
    pub max_touch_points: Option<u8>,
    pub language: Option<String>,
    pub timezone: Option<String>,
    pub tz_offset_minutes: Option<i32>,
    pub fonts: Option<Vec<String>>,
    pub seed: u32,
    /// Versión completa de Chrome del kit del catálogo (p.ej. "151.0.3.42").
    pub chrome_full_version: Option<String>,
    /// platformVersion de Client Hints del kit (por familia de OS).
    pub ch_platform_version: Option<String>,
    // Coordenadas de Geo-Coherencia
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
}

/// Contadores de tráfico por sesión (para presupuestar el gasto del proxy).
/// Se alimentan con `Network.loadingFinished.encodedDataLength` de cada página.
#[derive(Default)]
pub struct TrafficStats {
    bytes: std::sync::atomic::AtomicU64,
    requests: std::sync::atomic::AtomicU64,
}

impl TrafficStats {
    pub fn new() -> Self {
        Self::default()
    }

    /// Devuelve (bytes de cuerpo entregados, nº de peticiones de red).
    pub fn snapshot(&self) -> (u64, u64) {
        use std::sync::atomic::Ordering;
        (self.bytes.load(Ordering::Relaxed), self.requests.load(Ordering::Relaxed))
    }

    /// Aporta bytes/peticiones contados en el conector ProxyShield (nivel túnel).
    pub fn add_connector(&self, bytes: u64, requests: u64) {
        use std::sync::atomic::Ordering;
        self.bytes.fetch_add(bytes, Ordering::Relaxed);
        self.requests.fetch_add(requests, Ordering::Relaxed);
    }
}

/// Versión de Chrome que se anuncia si, en un path remoto, no hay ninguna
/// disponible en la identidad del perfil. Antes era una constante fija
/// ("132.0.6834.160") que la app anunciaba a todos los clientes durante meses
/// tras publicarse un major nuevo. Ahora sale del motor instalado, y solo si el
/// motor no se puede consultar se usa el major fijado en el catálogo.
fn chrome_version() -> &'static str {
    static V: LazyLock<String> = LazyLock::new(|| {
        crate::launcher::browser_full_version()
            .unwrap_or_else(|_| format!("{}.0.0.0", crate::pools::DEFAULT_MAJOR))
    });
    V.as_str()
}

/// Extrae de forma segura la versión completa de Chrome desde un User-Agent
/// (ej. "Chrome/132.0.6834.160").
///
/// Acepta `Option<&str>` porque `FingerprintIdentity::user_agent` es opcional:
/// cuando el servidor no dicta identidad, el perfil arranca con la del host y
/// puede no haber UA que parsear. Antes se pasaba `&identity.user_agent`
/// (&Option<String>) a un `&str`, que no compila.
fn extract_chrome_version(ua: Option<&str>) -> Option<&str> {
    let ua = ua?;
    if let Some(pos) = ua.find("Chrome/") {
        let after = &ua[pos + 7..];
        let ver = after.split(|c: char| !c.is_ascii_digit() && c != '.').next()?;
        if !ver.is_empty() {
            return Some(ver);
        }
    }
    None
}

/// Plantilla de fuentes para perfiles Linux. Un escritorio real (DejaVu,
/// Liberation, Noto, Free, alias mscorefonts + GNOME) enumera decenas de
/// fuentes; declarar solo 4 delata al fingerprint (CreepJS 'low font count').
const FONTS_LINUX: &[&str] = &[
    "DejaVu Sans", "DejaVu Sans Light", "DejaVu Sans Condensed", "DejaVu Sans Mono",
    "DejaVu Serif", "DejaVu Serif Condensed", "Liberation Sans", "Liberation Sans Narrow",
    "Liberation Serif", "Liberation Mono", "Noto Sans", "Noto Sans Mono", "Noto Serif",
    "Noto Color Emoji", "Noto Sans Symbols", "Noto Sans Symbols 2", "Noto Sans Math",
    "Noto Sans Arabic", "Noto Sans Armenian", "Noto Sans Bengali", "Noto Sans Devanagari",
    "Noto Sans Hebrew", "Noto Sans Thai", "Noto Sans CJK SC", "Cantarell",
    "FreeSans", "FreeSerif", "FreeMono", "Arial", "Arial Black", "Courier New",
    "Times New Roman", "Verdana", "Impact", "Trebuchet MS", "Comic Sans MS", "Georgia",
    "Helvetica", "Courier", "Times", "Bitstream Vera Sans Mono", "Bitstream Vera Sans",
    "Bitstream Vera Serif", "Ubuntu", "Ubuntu Mono", "OpenSymbol", "Symbola", "Lato",
    "Carlito", "Caladea",
];

/// Plantilla de fuentes para perfiles Windows.
///
/// Antes no existía: `create_identity` dejaba la lista vacía confiando en un
/// "fallback JS (winList)" que nunca se implementó, así que los perfiles de
/// Windows no declaraban ninguna fuente. Un Windows 11 real trae un conjunto
/// grande y reconocible; declararlo como vacío delata el perfil tanto como
/// declarar las fuentes de Linux.
///
/// El shim usa esta lista para `measureText` y `document.fonts.check`, de modo
/// que la enumeración de fuentes devuelve este conjunto y no el del host.
const FONTS_WIN: &[&str] = &[
    // Base
    "Arial", "Arial Black", "Bahnschrift", "Calibri", "Calibri Light", "Cambria",
    "Cambria Math", "Candara", "Comic Sans MS", "Consolas", "Constantia", "Corbel",
    "Courier", "Courier New", "Ebrima", "Franklin Gothic Medium", "Gabriola",
    "Gadugi", "Georgia", "HoloLens MDL2 Assets", "Impact", "Ink Free", "Javanese Text",
    "Leelawadee UI", "Lucida Console", "Lucida Sans Unicode", "Malgun Gothic",
    "Marlett", "Microsoft Himalaya", "Microsoft JhengHei", "Microsoft New Tai Lue",
    "Microsoft PhagsPa", "Microsoft Sans Serif", "Microsoft Tai Le", "Microsoft YaHei",
    "Microsoft Yi Baiti", "MingLiU-ExtB", "Mongolian Baiti", "MS Gothic", "MV Boli",
    "Myanmar Text", "Nirmala UI", "Palatino Linotype", "Segoe MDL2 Assets",
    "Segoe Print", "Segoe Script", "Segoe UI", "Segoe UI Emoji", "Segoe UI Historic",
    "Segoe UI Symbol", "SimSun", "Sitka", "Sylfaen", "Symbol", "Tahoma",
    "Times New Roman", "Trebuchet MS", "Verdana", "Webdings", "Wingdings",
    // Aplicaciones que suelen estar instaladas
    "Aptos", "Aptos Display", "Aptos Mono", "Aptos Narrow", "Aptos SemiBold",
    "Bahnschrift SemiBold", "Bahnschrift Light", "Bahnschrift SemiLight",
];

/// Plantilla de fuentes para perfiles macOS.
///
/// Ampliada el 04/10/2026 de 41 a 100 entradas. Con 41, el núcleo inevitable
/// (22) dejaba solo 19 rotables y el recuento se quedaba entre 33 y 39: por
/// encima del umbral de 'low font count', pero con tan poco margen que
/// cualquier recorte futuro lo cruzaba. Un macOS real enumera bastante más de
/// 41 fuentes, así que la lista corta era además poco creíble.
const FONTS_MAC: &[&str] = &[
    // Del sistema
    "Helvetica", "Helvetica Neue", "Times", "Arial", "Arial Black", "Courier",
    "Courier New", "Geneva", "Verdana", "Tahoma", "Trebuchet MS", "Georgia", "Palatino",
    "Palatino Linotype", "Optima", "Futura", "Gill Sans", "Gill Sans MT", "Lucida Grande",
    "Monaco", "Menlo", "Apple SD Gothic Neo", "PingFang SC", "PingFang HK", "PingFang TC",
    "Hiragino Sans", "Hiragino Kaku Gothic ProN", "SF Pro Text", "SF Pro Display",
    "SF Mono", "Avenir", "Avenir Next", "Avenir Next Condensed", "Comic Sans MS", "Impact",
    "Marker Felt", "Snell Roundhand", "Chalkboard", "American Typewriter", "Symbol",
    "Zapf Dingbats",
    // Tipografías de contraste y decorativas que sí trae macOS
    "Apple Chancery", "Apple Color Emoji", "Apple Symbols", "Arial Rounded MT Bold",
    "Arial Unicode MS", "Baskerville", "Big Caslon", "Bodoni 72", "Bodoni 72 Oldstyle",
    "Bodoni 72 Smallcaps", "Bradley Hand", "Brush Script MT", "Cochin", "Copperplate",
    "Copperplate Gothic Light", "Didot", "DIN Alternate", "DIN Condensed", "Hoefler Text",
    "Iowan Old Style", "Noteworthy", "Papyrus", "Phosphate", "Rockwell", "Savoye LET",
    "Skia", "Superclarendon", "Times New Roman", "Trattatello", "Webdings", "Wingdings",
    // Multilingües, que macOS trae por defecto
    "Arial Hebrew", "Arial Nova", "Athelas", "Devanagari Sangam MN",
    "Gujarati Sangam MN", "Kailasa", "Kefa", "Khmer UI", "Krungthep",
    "Lantinghei SC", "LiSong Pro", "Muna", "Myanmar Sangam MN", "Sathu",
    "STIXGeneral", "STIXTwo Math", "Telugu Sangam MN", "Thonburi", "Yuanti SC",
    // Escritorio, presentes en Mac con las aplicaciones de Microsoft instaladas
    "Calibri", "Cambria", "Candara", "Consolas", "Corbel", "Constantia",
    "Franklin Gothic Book", "Garamond", "Lucida Sans Unicode",
];

/// Fuentes que un perfil declara SIEMPRE, sea cual sea su seed.
///
/// Estas no se rotan porque su ausencia delata más que su repetición: un Windows
/// sin Segoe UI, ni Consolas ni Courier New no es un Windows que nadie tenga. Lo
/// que se rota es el resto, que es donde un equipo tieneinstalled de más o de
/// menos según para qué se usa.
const FONT_CORE_WIN: &[&str] = &[
    "Segoe UI", "Segoe UI Symbol", "Segoe MDL2 Assets", "Arial", "Arial Black",
    "Times New Roman", "Courier New", "Verdana", "Georgia", "Tahoma", "Trebuchet MS",
    "Impact", "Comic Sans MS", "Calibri", "Consolas", "Cambria", "Candara", "Corbel",
    "Constantia", "Franklin Gothic Medium",
];

const FONT_CORE_MAC: &[&str] = &[
    "Helvetica", "Helvetica Neue", "Menlo", "Monaco", "Courier", "Arial", "Arial Black",
    "Times New Roman", "Verdana", "Georgia", "Tahoma", "Geneva", "Palatino", "Optima",
    "Futura", "Apple SD Gothic Neo", "PingFang SC", "SF Pro Text", "SF Mono",
    "Avenir Next", "Symbol", "Zapf Dingbats",
];

const FONT_CORE_LINUX: &[&str] = &[
    "DejaVu Sans", "DejaVu Sans Mono", "DejaVu Serif", "Liberation Sans",
    "Liberation Serif", "Liberation Mono", "Noto Sans", "Ubuntu", "Ubuntu Mono",
    "FreeSans", "FreeSerif", "FreeMono", "Cantarell", "Carlito", "Caladea", "Lato",
];

/// Fuentes de un Android real. Antes un perfil de móvil pedía las de Linux de
/// escritorio: 'DejaVu Sans', 'Ubuntu', 'Cantarell'. Ninguna existe en un
// teléfono, así que medir fuentes en un móvil lo delataba de inmediato.
const FONTS_ANDROID: &[&str] = &[
    "Roboto", "Roboto Light", "Roboto Medium", "Roboto Condensed", "Roboto Mono",
    "Noto Sans", "Noto Sans Mono", "Noto Serif", "Noto Color Emoji", "Noto Sans Symbols",
    "Droid Sans", "Droid Sans Mono", "Droid Serif", "Droid Sans Fallback",
    "Sans Serif", "Sans Serif Light", "Sans Serif Condensed", "Sans Serif Medium",
    "Monospace", "Arial", "Verdana", "Georgia", "Times New Roman", "Helvetica",
    "Comic Sans MS", "Trebuchet MS", "Courier New",
];

const FONT_CORE_ANDROID: &[&str] = &[
    "Roboto", "Roboto Light", "Roboto Medium", "Roboto Mono", "Noto Sans",
    "Droid Sans", "Droid Sans Mono", "Sans Serif", "Monospace", "Arial", "Helvetica",
];

/// Plantilla completa de fuentes del SO indicado.
fn font_template(os: &str) -> &'static [&'static str] {
    if os.contains("win") {
        FONTS_WIN
    } else if os.contains("mac") {
        FONTS_MAC
    } else if os.contains("android") {
        FONTS_ANDROID
    } else {
        FONTS_LINUX
    }
}

/// Núcleo siempre presente del SO indicado.
fn font_core(os: &str) -> &'static [&'static str] {
    if os.contains("win") {
        FONT_CORE_WIN
    } else if os.contains("mac") {
        FONT_CORE_MAC
    } else if os.contains("android") {
        FONT_CORE_ANDROID
    } else {
        FONT_CORE_LINUX
    }
}

/// Fuentes declaradas por un perfil concreto: el núcleo del SO más un subconjunto
/// rotado del resto, determinado por el seed del perfil.
///
/// POR QUÉ NO BASTA LA PLANTILLA ENTERA
///
/// Con la plantilla fija, todos los perfiles Windows de la misma instalación
/// declaraban EXACTAMENTE la misma lista. Eso no lo delata un detector de
/// fuentes: lo delata un detector que correlaciona dos perfiles de la misma
/// cuenta. Las cookies son distintas, el UA es distinto, y de pronto las dos
/// sesiones comparten seventy fuentes byte a byte. Eso es un enlace entre
/// perfiles, y es justo lo que un antidetect no puede permitirse.
///
/// La rotación es determinista por profile_id: el mismo perfil declara siempre
/// las mismas fuentes, en el mismo orden, en cada arranque.
///
/// El recorte es del 60-100% del resto, nunca del núcleo: declarar cuatro
/// fuentes la delata CreepJS como 'low font count', igual que declarar ninguna.
fn font_set(os: &str, seed: u32) -> Vec<String> {
    let core = font_core(os);
    let mut rest: Vec<&str> = font_template(os)
        .iter()
        .copied()
        .filter(|f| !core.contains(f))
        .collect();

    // Fisher-Yates con el mismo LCG que ya usa encode_shim(), sembrado con el
    // seed del perfil. Barajar sin sesgo es lo que hace que el recorte sea
    // aleatorio de verdad y no "quedarse con los primeros".
    let mut key = seed ^ 0x9E37_79B9;
    for i in (1..rest.len()).rev() {
        key = key.wrapping_mul(1664525).wrapping_add(1013904223);
        let j = (key >> 16) as usize % (i + 1);
        rest.swap(i, j);
    }

    let min = rest.len() * 60 / 100;
    let span = (rest.len() * 40 / 100).max(1);
    key = key.wrapping_mul(1664525).wrapping_add(1013904223);
    let take = (min + (key >> 16) as usize % span).min(rest.len());

    let mut out: Vec<String> = Vec::with_capacity(core.len() + take);
    out.extend(core.iter().map(|f| f.to_string()));
    out.extend(rest[..take].iter().map(|f| f.to_string()));
    out
}

fn fnv1a(data: &[u8]) -> u32 {
    let mut hash: u32 = 0x811c9dc5;
    for byte in data {
        hash ^= *byte as u32;
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

/// Fuentes de verdad para un tz => offset en minutos (positivo al Oeste de UTC).
pub(crate) fn tz_offset_minutes(tz: &str) -> Option<i32> {
    let t = tz.to_ascii_lowercase();
    Some(match t.as_str() {
        "america/bogota" | "america/panama" | "america/lima" | "america/guayaquil" | "america/quito" => 300,
        "america/caracas" => 240,
        "america/mexico_city" | "america/regina" => 360,
        "america/new_york" | "america/toronto" | "america/havana" => 300,
        "america/chicago" | "america/guatemala" => 360,
        "america/denver" => 420,
        "america/los_angeles" | "america/vancouver" => 480,
        "america/argentina/buenos_aires" | "america/sao_paulo" => 180,
        "america/santiago" => 180,
        "europe/madrid" | "europe/paris" | "europe/berlin" | "europe/rome" | "europe/amsterdam" => -60,
        "europe/london" | "europe/lisbon" | "africa/casablanca" => 0,
        "europe/moscow" => 180,
        "europe/kiev" | "europe/kyiv" | "europe/athens" | "europe/bucharest" => -120,
        "africa/cairo" => -120,
        "asia/istanbul" => -180,
        "asia/dubai" => -240,
        "asia/kolkata" => -330,
        "asia/bangkok" | "asia/jakarta" | "asia/hanoi" | "asia/ho_chi_minh" => -420,
        "asia/manila" | "asia/singapore" | "asia/shanghai" | "asia/hong_kong" => -480,
        "asia/tokyo" | "asia/seoul" => -540,
        "australia/sydney" => -660,
        "pacific/auckland" => -720,
        "europe/warsaw" => -60,
        other => {
            if other.starts_with("utc") || other == "gmt" || other == "greenwich" {
                0
            } else {
                return None;
            }
        }
    })
}

/// SO del host en las claves del catálogo (`windows` | `macos` | `linux`).
pub fn host_os_key() -> &'static str {
    match std::env::consts::OS {
        "windows" => "windows",
        "macos" => "macos",
        _ => "linux",
    }
}

/// Construye la identidad coherente a partir de la configuración de lanzamiento.
pub fn build_identity(config: &LaunchConfig) -> FingerprintIdentity {
    // Si el lanzamiento viene con fingerprint_json del servidor, la receta la
    // dicta el backend (no se puede robar del binario). Fallback local si no.
    // El SO anunciado es SIEMPRE el del host. Una receta de otro sistema (los
    // perfiles nacían 'windows' por un valor fijo de la UI) no se puede
    // sostener: el render real de la GPU, las fuentes, los workers y la pila de
    // red siguen siendo del host. Si la receta es de otro SO se descarta y la
    // identidad sale del catálogo local para el SO real (mismo seed).
    let server_fp: Option<ServerFingerprint> = config
        .fingerprint_json
        .as_deref()
        .and_then(|raw| serde_json::from_str::<ServerFingerprint>(raw).ok())
        .filter(|s| s.os_key == host_os_key());

    let seed = server_fp
        .as_ref()
        .map(|s| s.seed)
        .unwrap_or_else(|| fnv1a(config.profile_id.as_bytes()));

    let mut os = config.os.as_deref().unwrap_or("").to_lowercase();

    // Sin OS declarado hay que derivarlo igual: UA, navigator.platform, Client
    // Hints, GL_TABLE y voces deben pertenecer a UN SOLO sistema. Antes, con os
    // vacío, platform quedaba sin espoofear (navigator real del host) mientras
    // GL rotaba sobre las 8 filas de TODAS las plataformas -> una sesión
    // Chrome/Linux podía mostrar una GPU Windows/D3D11 (Pixelscan 'Masking
    // detected'). Orden: receta del servidor > os declarado > pista del UA > host.
    if let Some(sfp) = &server_fp {
        os = match sfp.os_key.as_str() {
            "windows" => "win".to_string(),
            "macos" => "mac".to_string(),
            // Antes android e iOS caían en 'linux': el shim les ponía una GPU
            // NVIDIA de escritorio y fuentes 'DejaVu Sans' y 'Ubuntu', que en un
            // teléfono delatan al instante. Ahora tienen su propia familia.
            "android" => "android".to_string(),
            "ios" => "iphone".to_string(),
            _ => "linux".to_string(),
        };
    } else if os.is_empty() {
        if let Some(ua) = &config.user_agent {
            let u = ua.to_lowercase();
            if u.contains("windows nt") || u.contains("win64") {
                os = "win".to_string();
            } else if u.contains("macintosh") || u.contains("mac os x") {
                os = "mac".to_string();
            } else if u.contains("android") {
                os = "android".to_string();
            } else if u.contains("iphone") {
                os = "iphone".to_string();
            }
        }
    }
    // Lo declarado por el perfil o por su UA ya no puede imponer otro SO.
    os = match host_os_key() {
        "windows" => "win",
        "macos" => "mac",
        _ => "linux",
    }
    .to_string();

    let mut identity = FingerprintIdentity { seed, ..Default::default() };

    // Kit de identidad rotativo del catálogo (pools.rs), determinista por seed:
    // major de Chrome + versión completa, plataforma, OS de la UA, memoria/cores,
    // timezone e idioma salen del MISMO seed => coherentes entre sí. Si viene la
    // receta del servidor, se usa tal cual (misma matemática, otra procedencia).
    let catalog = if let Some(sfp) = &server_fp {
        // La receta del servidor aporta la IDENTIDAD (kit, pantalla, región), pero
        // NUNCA la versión de Chrome.
        //
        // Antes se aceptaba `sfp.identity.full_version` tal cual, y los motores
        // del backend declaraban Chrome 144 y 149-151 mientras el motor es 154:
        // en el camino de producción (que es el normal, vía POST /api/fingerprint)
        // eso reintroducía exactamente la incoherencia que se corrigió en el
        // camino local. La versión la impone SIEMPRE el binario que se ejecuta,
        // porque es la única que concuerda con la firma TLS y el HTTP/2.
        let engine_version = crate::launcher::browser_full_version().ok();
        let (engine_major, engine_full) = match engine_version.as_deref() {
            Some(v) => (crate::pools::pick_chrome_major(v).unwrap_or(crate::pools::DEFAULT_MAJOR), v.to_string()),
            None => (sfp.identity.major, sfp.identity.full_version.clone()),
        };
        Some(crate::pools::CatalogIdentity {
            os_key: sfp.os_key.clone(),
            kit_id: sfp.identity.kit_id.clone(),
            full_version: engine_full,
            major: engine_major,
            platform: sfp.identity.platform.clone(),
            ua_os: sfp.identity.ua_os.clone(),
            platform_version: sfp.identity.platform_version.clone(),
            screen_width: sfp.identity.screen_width,
            screen_height: sfp.identity.screen_height,
            device_pixel_ratio: sfp.identity.device_pixel_ratio,
            device_memory: sfp.identity.device_memory,
            cores: sfp.identity.cores,
            timezone: sfp.identity.timezone.clone(),
            language: sfp.identity.language.clone(),
            geo_id: crate::pools::geo_id_for(
                &sfp.identity.timezone,
                &sfp.identity.language,
            ),
        })
    } else {
        let os_key = if os.contains("win") {
            "windows"
        } else if os.contains("mac") {
            "macos"
        } else {
            "linux"
        };
        // La versión anunciada es la del motor que se va a ejecutar realmente.
        // Antes se anunciaba un array fijo ([131,132,132,132,133]) que dejó de
        // coincidir con el binario: incoherencia detectable por feature
        // detection y por la firma TLS/HTTP2 de red.
        let engine_version = crate::launcher::browser_full_version().ok();
        // Si el GeoIP del proxy ya nos dice el país, la región geográfica la
        // manda sobre la del seed: evita anunciar timezone de Japón con una IP
        // alemana, que es la incoherencia que delata el tráfico automatizado.
        let geo = crate::pools::geo_for(
            seed,
            config.latitude.filter(|v| v.is_finite()),
            config.longitude.filter(|v| v.is_finite()),
        );
        Some(crate::pools::select_full(
            seed,
            os_key,
            engine_version.as_deref(),
            Some(geo),
        ))
    };

    if let Some(cid) = &catalog {
        let touch = if os.contains("mac") { 1 } else { 0 };
        // Formato reducido (Chrome/156.0.0.0): es el que manda Chrome real; la
        // versión completa solo viaja en los Client Hints (chrome_full_version).
        identity.user_agent = Some(format!(
            "Mozilla/5.0 ({}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{}.0.0.0 Safari/537.36",
            cid.ua_os, cid.major
        ));
        identity.platform = Some(cid.platform.to_string());
        identity.vendor = Some("Google Inc.".to_string());
        // Núcleos y memoria NO se falsean: los Web Workers dedicados no reciben el
        // shim (783c07a: adjuntarse a workers provocaba SIGILL) y devuelven los
        // valores reales. Pixelscan comparaba página (16 núcleos del catálogo)
        // con worker (4 reales) y marcaba "Masking detected". Con el valor real,
        // página y worker coinciden. La diversidad sigue en pantalla, GPU, etc.
        identity.hardware_concurrency = None;
        identity.device_memory = None;
        identity.max_touch_points = Some(touch);
        identity.chrome_full_version = Some(cid.full_version.clone());
        identity.ch_platform_version = Some(cid.platform_version.to_string());

        // Fuentes "instaladas" del perfil: núcleo del SO más un subconjunto
        // rotado por seed. El shim las usa para measureText y
        // document.fonts.check: sin ellas, un perfil Windows emulado sobre Linux
        // devolvía las fuentes reales del host. Y al rotar por seed, dos perfiles
        // del mismo usuario dejan de declarar la lista exacta, que era un
        // enlace entre ellos.
        identity.fonts = Some(font_set(&os, seed));
    }

    // Un UA explícito siempre gana sobre el compuesto.
    if let Some(ua) = &config.user_agent {
        let t = ua.trim();
        if !t.is_empty() {
            identity.user_agent = Some(t.to_string());
        }
    }

    match (config.screen_width, config.screen_height) {
        (Some(w), Some(h)) => {
            identity.screen_width = Some(w);
            identity.screen_height = Some(h);
            identity.device_pixel_ratio = Some(1.0);
        }
        _ => {
            if let Some(cid) = &catalog {
                identity.screen_width = Some(cid.screen_width);
                identity.screen_height = Some(cid.screen_height);
                identity.device_pixel_ratio = Some(cid.device_pixel_ratio);
            }
        }
    }
    // Una pantalla menor que el monitor real es imposible (la ventana real no
    // cabría en ella): en ese caso se anuncia la real.
    if let (Some(hw), Some(hh)) = (config.host_screen_width, config.host_screen_height) {
        if identity.screen_width.is_some_and(|w| w < hw) || identity.screen_height.is_some_and(|h| h < hh) {
            identity.screen_width = Some(hw);
            identity.screen_height = Some(hh);
        }
    }

    let has_proxy = config.proxy.as_ref().map(|p| !p.trim().is_empty()).unwrap_or(false);

    if let Some(locale) = &config.locale {
        let t = locale.trim();
        if !t.is_empty() {
            identity.language = Some(t.to_string());
        }
    } else if !has_proxy {
        // Sin proxy: adaptarse dinámicamente al idioma real del sistema operativo del cliente (internacional)
        let sys_locale = std::env::var("LC_ALL")
            .or_else(|_| std::env::var("LC_MESSAGES"))
            .or_else(|_| std::env::var("LANG"))
            .ok()
            .and_then(|l| {
                let clean = l.split('.').next()?.replace('_', "-");
                if clean.is_empty() { None } else { Some(clean) }
            })
            .unwrap_or_else(|| "es-MX".to_string());
        identity.language = Some(sys_locale);
    } else if let Some(cid) = &catalog {
        identity.language = Some(cid.language.to_string());
    }

    // Timezone explícito del perfil gana; si falta y no hay proxy, detectar dinámicamente
    // la zona horaria real del host para cualquier parte del mundo.
    let tz_source = config
        .timezone
        .as_deref()
        .filter(|t| !t.trim().is_empty())
        .map(|t| t.trim().to_string())
        .or_else(|| {
            if !has_proxy {
                // Leer enlace simbólico de /etc/localtime en Linux o variable TZ
                std::env::var("TZ").ok().filter(|z| !z.trim().is_empty()).or_else(|| {
                    #[cfg(target_os = "linux")]
                    {
                        if let Ok(dest) = std::fs::read_link("/etc/localtime") {
                            let s = dest.to_string_lossy().to_string();
                            if let Some(pos) = s.find("zoneinfo/") {
                                return Some(s[pos + 9..].to_string());
                            }
                        }
                    }
                    Some("America/Mexico_City".to_string())
                })
            } else {
                catalog.as_ref().map(|c| c.timezone.to_string())
            }
        });
    if let Some(tz) = tz_source {
        identity.timezone = Some(tz.trim().to_string());
        identity.tz_offset_minutes = tz_offset_minutes(tz.trim());
    }

    identity.latitude = config.latitude;
    identity.longitude = config.longitude;

    identity
}

/// Lanza el inyector CDP en segundo plano. No bloquea el arranque del perfil.
pub fn spawn_fingerprint_injector(
    user_data_dir: PathBuf,
    identity: FingerprintIdentity,
    stats: std::sync::Arc<TrafficStats>,
) {
    thread::spawn(move || {
        if let Err(err) = run_injector(&user_data_dir, &identity, &stats) {
            eprintln!("[cdp] inyector de huellas finalizado sin cobertura completa: {}", err);
        }
    });
}

fn run_injector(
    user_data_dir: &std::path::Path,
    identity: &FingerprintIdentity,
    stats: &TrafficStats,
) -> Result<(), String> {
    // 1. Chrome escribe el puerto dinámico y la ruta del browser target en DevToolsActivePort.
    //    Como el puerto es dinámico (`--remote-debugging-port=0`) y Chrome puede tardar en
    //    sobrescribir el archivo tras arrancar, leer + probar conexión de forma repetida:
    //    si el puerto leído es stale/muerto, se relee el archivo y se reintenta hasta el deadline.
    let port_file = user_data_dir.join("DevToolsActivePort");
    let deadline = Instant::now() + Duration::from_secs(15);
    let (mut ws, _response) = loop {
        if let Ok(content) = std::fs::read_to_string(&port_file) {
            let mut lines = content.lines();
            if let (Some(port_line), Some(path_line)) = (lines.next(), lines.next()) {
                if let Ok(port) = port_line.trim().parse::<u16>() {
                    let endpoint = format!("ws://127.0.0.1:{}{}", port, path_line.trim());
                    match connect(&endpoint) {
                        Ok(c) => break c,
                        Err(e) => {
                            // El puerto del archivo no responde (stale): podría ser de una
                            // instancia anterior. Releer el archivo al siguiente intento.
                            eprintln!(
                                "[cdp] puerto DevToolsActivePort muerto ({}:{}): {}, reintentando",
                                port, e, endpoint
                            );
                        }
                    }
                }
            }
        }
        if Instant::now() > deadline {
            return Err("timeout esperando conexión CDP (DevToolsActivePort)".to_string());
        }
        thread::sleep(Duration::from_millis(120));
    };

    // 2. Auto-adjuntar a todos los targets presentes y futuros (flatten: sesiones en root ws).
    // waitForDebuggerOnStart: true garantiza que NINGÚN script (incluyendo Cloudflare Turnstile
    // en enlaces abiertos desde Google) pueda ejecutarse antes de que User-Agent, timezone y shim
    // estén 100% aplicados en el nuevo target.
    //
    // filter page/iframe: NO adjuntar targets de workers (service_worker/shared_worker).
    // Adjuntarse a un worker con waitForDebuggerOnStart + Runtime.evaluate provoca un CHECK
    // interno de Chromium al cerrar el hilo del worker (blink::WorkerBackingThread::
    // ShutdownOnBackingThread) que mata el proceso del hilo con SIGILL; con tabs extra el sitio
    // re-registra el worker y el ciclo crash-relaunch devora la CPU. Los workers no necesitan del
    // shim de huella (la detección corre en el documento, no en el worker); el UA de red
    // que ven los fetch del worker se controla desde el override del page/iframe.
    // Verificado in situ: con filter el motor 156 solo adjunta page/iframe y no hay traps
    // (journal: sin `ServiceWorker t ... trap invalid opcode`).
    let attach = json!({
        "id": 1,
        "method": "Target.setAutoAttach",
        "params": {
            "autoAttach": true,
            "waitForDebuggerOnStart": true,
            "flatten": true,
            "filter": [ { "type": "page" }, { "type": "iframe" } ]
        }
    })
    .to_string();
    ws.send(Message::Text(attach.into()))
        .map_err(|e| format!("enviando setAutoAttach: {}", e))?;

    let shim = build_shim(identity);
    let mut cmd_id: u64 = 100;
    // Contadores de ordenes CDP: si alguna no se puede enviar, la sesion de CDP
    // esta perdida y el perfil NO debe arrancar con la huella del host.
    let mut sent: usize = 0;
    let mut failures: Vec<String> = Vec::new();

    loop {
        let text = match ws.read() {
            Ok(Message::Text(t)) => t,
            Ok(Message::Close(_)) | Ok(Message::Ping(_)) | Ok(Message::Pong(_)) => continue,
            Ok(_) => continue,
            Err(_) => break,
        };

        let Ok(msg) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };

        // Telemetría de tráfico: el cuerpo entregado por petición (lo que el proxy
        // factura aproximadamente). Se cuenta aquí para no depender del proveedor.
        if let Some(method) = msg.get("method").and_then(|m| m.as_str()) {
            if method == "Network.loadingFinished" {
                if let Some(enc) = msg.pointer("/params/encodedDataLength").and_then(|v| v.as_f64()) {
                    use std::sync::atomic::Ordering;
                    stats.requests.fetch_add(1, Ordering::Relaxed);
                    stats.bytes.fetch_add(enc.max(0.0) as u64, Ordering::Relaxed);
                }
                continue;
            }
            if method != "Target.attachedToTarget" {
                continue;
            }
        } else {
            continue;
        }

        let Some(session_id) = msg.pointer("/params/sessionId").and_then(|v| v.as_str()) else {
            continue;
        };
        let target_type = msg
            .pointer("/params/targetInfo/type")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let session = session_id.to_string();

        if target_type != "page" && target_type != "iframe" {
            if target_type == "worker" || target_type == "service_worker" || target_type == "shared_worker" {
                // Configurar Network y User-Agent en el contexto de Worker
                cmd_id += 1;
                let net_enable = json!({"id": cmd_id, "sessionId": session, "method": "Network.enable", "params": {}}).to_string();
                sent += cdp_send(&mut ws, &net_enable, "Network.enable", &mut failures);

                let (ch_platform, ch_platform_version, ch_brands, ch_full_version_list) = client_hints(identity);
                let extracted_ver = extract_chrome_version(identity.user_agent.as_deref());
                let full_ver = identity.chrome_full_version.as_deref().or(extracted_ver).map(|v| v.to_string()).unwrap_or_else(|| chrome_version().to_string());
                let is_mobile = identity.user_agent.as_deref().is_some_and(|ua| ua.contains("Mobile") || ua.contains("Android"));
                let is_mac = ch_platform == "macOS";
                let arch = if is_mobile || is_mac { "arm" } else { "x86" };
                let mut ua_params = json!({
                    "userAgent": identity.user_agent,
                    "userAgentReduction": false,
                    "platform": ch_platform,
                    "userAgentMetadata": {
                        "brands": ch_brands,
                        "fullVersionList": ch_full_version_list,
                        "fullVersion": full_ver,
                        "platform": ch_platform,
                        "platformVersion": ch_platform_version,
                        "architecture": arch,
                        "bitness": "64",
                        "model": if is_mobile { "SM-S918B" } else { "" },
                        "mobile": is_mobile,
                        "wow64": false
                    }
                });
                if let Some(al) = accept_language(&identity.language) {
                    ua_params["acceptLanguage"] = json!(al);
                }
                cmd_id += 1;
                let ua_override = json!({ "id": cmd_id, "sessionId": session, "method": "Network.setUserAgentOverride", "params": ua_params }).to_string();
                sent += cdp_send(&mut ws, &ua_override, "Network.setUserAgentOverride", &mut failures);

                // Evaluar el shim en el worker global scope antes de que ejecute ningún script
                cmd_id += 1;
                let eval_msg = json!({
                    "id": cmd_id,
                    "sessionId": session,
                    "method": "Runtime.evaluate",
                    "params": {
                        "expression": shim,
                        "returnByValue": true
                    }
                }).to_string();
                sent += cdp_send(&mut ws, &eval_msg, "Runtime.evaluate", &mut failures);
            }

            // Reanudar inmediatamente targets que no sean página/iframe (workers/service_workers)
            cmd_id += 1;
            let resume = json!({
                "id": cmd_id,
                "sessionId": session,
                "method": "Runtime.runIfWaitingForDebugger",
                "params": {}
            })
            .to_string();
            sent += cdp_send(&mut ws, &resume, "Runtime.runIfWaitingForDebugger", &mut failures);
            continue;
        }

        // Presentar el target para poder inyectar.
        cmd_id += 1;
        let enable = json!({"id": cmd_id, "sessionId": session, "method": "Page.enable", "params": {}}).to_string();
        sent += cdp_send(&mut ws, &enable, "Page.enable", &mut failures);

        // Client Hints nativos: Network.setUserAgentOverride rellena navigator.userAgentData
        // a nivel Blink (no es una redefinición JS), coherente con el UA del perfil.
        // Enviar en cada página para cubrir iframes/viajes posteriores.
        cmd_id += 1;
        let net_enable = json!({"id": cmd_id, "sessionId": session, "method": "Network.enable", "params": {}}).to_string();
        sent += cdp_send(&mut ws, &net_enable, "Network.enable", &mut failures);

        let (ch_platform, ch_platform_version, ch_brands, ch_full_version_list) = client_hints(identity);
        let extracted_ver = extract_chrome_version(identity.user_agent.as_deref());
        let full_ver = identity.chrome_full_version.as_deref().or(extracted_ver).map(|v| v.to_string()).unwrap_or_else(|| chrome_version().to_string());
        let is_mobile = identity.user_agent.as_deref().is_some_and(|ua| ua.contains("Mobile") || ua.contains("Android"));
        let is_mac = ch_platform == "macOS";
        let arch = if is_mobile || is_mac { "arm" } else { "x86" };
        let mut ua_params = json!({
            "userAgent": identity.user_agent,
            "userAgentReduction": false,
            "platform": ch_platform,
            "userAgentMetadata": {
                "brands": ch_brands,
                "fullVersionList": ch_full_version_list,
                "fullVersion": full_ver,
                "platform": ch_platform,
                "platformVersion": ch_platform_version,
                "architecture": arch,
                "bitness": "64",
                "model": if is_mobile { "SM-S918B" } else { "" },
                "mobile": is_mobile,
                "wow64": false
            }
        });
        if let Some(al) = accept_language(&identity.language) {
            ua_params["acceptLanguage"] = json!(al);
        }
        cmd_id += 1;
        let ua_override = json!({ "id": cmd_id, "sessionId": session, "method": "Network.setUserAgentOverride", "params": ua_params }).to_string();
        sent += cdp_send(&mut ws, &ua_override, "Network.setUserAgentOverride", &mut failures);

        // Pantalla nativa. El shim la falseaba solo en JS (Screen.prototype) y las
        // media queries device-width/height seguían viendo la real: Pixelscan
        // marcaba "Masking detected". width/height 0 = no tocar el viewport;
        // deviceScaleFactor 0 = DPR real (falsearlo escalaría el render).
        if let (Some(sw), Some(sh)) = (identity.screen_width, identity.screen_height) {
            cmd_id += 1;
            let metrics = json!({
                "id": cmd_id,
                "sessionId": session,
                "method": "Emulation.setDeviceMetricsOverride",
                "params": {
                    "width": 0, "height": 0, "deviceScaleFactor": 0, "mobile": false,
                    "screenWidth": sw, "screenHeight": sh
                }
            })
            .to_string();
            sent += cdp_send(&mut ws, &metrics, "Emulation.setDeviceMetricsOverride", &mut failures);
        }

        // Timezone nativo por CDP (V8 / Chromium engine-level)
        if let Some(tz) = &identity.timezone {
            if !tz.trim().is_empty() {
                cmd_id += 1;
                let tz_override = json!({
                    "id": cmd_id,
                    "sessionId": session,
                    "method": "Emulation.setTimezoneOverride",
                    "params": { "timezoneId": tz.trim() }
                })
                .to_string();
                sent += cdp_send(&mut ws, &tz_override, "Emulation.setTimezoneOverride", &mut failures);
            }
        }

        // Locale nativo por CDP
        if let Some(lang) = &identity.language {
            if !lang.trim().is_empty() {
                cmd_id += 1;
                let loc_override = json!({
                    "id": cmd_id,
                    "sessionId": session,
                    "method": "Emulation.setLocaleOverride",
                    "params": { "locale": lang.trim() }
                })
                .to_string();
                sent += cdp_send(&mut ws, &loc_override, "Emulation.setLocaleOverride", &mut failures);
            }
        }

        // Geolocation nativo por CDP alineado con el nodo proxy (latitud / longitud)
        if let (Some(lat), Some(lon)) = (identity.latitude, identity.longitude) {
            cmd_id += 1;
            let geo_override = json!({
                "id": cmd_id,
                "sessionId": session,
                "method": "Emulation.setGeolocationOverride",
                "params": {
                    "latitude": lat,
                    "longitude": lon,
                    "accuracy": 85.0
                }
            })
            .to_string();
            sent += cdp_send(&mut ws, &geo_override, "Emulation.setGeolocationOverride", &mut failures);
        }

        // El shim corre en CADA documento nuevo (tabs y navegación).
        cmd_id += 1;
        let inject = json!({
            "id": cmd_id,
            "sessionId": session,
            "method": "Page.addScriptToEvaluateOnNewDocument",
            "params": { "source": shim }
        })
        .to_string();
        sent += cdp_send(&mut ws, &inject, "Page.addScriptToEvaluateOnNewDocument", &mut failures);

        // Reanudar el target: ahora que User-Agent, Client Hints, Timezone y Shim
        // están 100% instalados, el documento y sus scripts ya pueden arrancar.
        cmd_id += 1;
        let resume = json!({
            "id": cmd_id,
            "sessionId": session,
            "method": "Runtime.runIfWaitingForDebugger",
            "params": {}
        })
        .to_string();
        sent += cdp_send(&mut ws, &resume, "Runtime.runIfWaitingForDebugger", &mut failures);
    }

    // Un envío fallido significa que la sesión de CDP se perdió (el navegador se
    // cerró, el puerto cambió, el target murió). En ese estado el perfil se
    // ejecutaría con la huella REAL del host y sin shim, sin avisar a nadie:
    // el peor resultado posible en un producto antidetección. Se aborta.
    if !failures.is_empty() {
        return Err(format!(
            "No se pudo aplicar la huella: {} de {} órdenes CDP fallaron al enviarse ({}). \
             El perfil se aborta en lugar de arrancar con la huella del sistema, \
             que quedaría expuesta al instante.",
            failures.len(),
            sent,
            failures.join(", ")
        ));
    }

    Ok(())
}

/// El shim de huella: drivers coherentes de identidad + ruido determinista de canvas.
/// Se inyecta como script de "nuevo documento" para minimizar la superficie de detección.
/// Client Hints coherentes con el perfil: plataforma, versión, brands y lista completa.
fn client_hints(identity: &FingerprintIdentity) -> (String, String, serde_json::Value, serde_json::Value) {
    let extracted_ver = extract_chrome_version(identity.user_agent.as_deref());
    let full_version = identity
        .chrome_full_version
        .as_deref()
        .or(extracted_ver)
        .map(|v| v.to_string())
        .unwrap_or_else(|| chrome_version().to_string());
    // El major de los Client Hints DEBE salir de la misma versión que la UA: si
    // divergen, `navigator.userAgentData.brands` y la cabecera de red se
    // contradicen entre sí.
    let major = crate::pools::pick_chrome_major(&full_version)
        .map(|m| m.to_string())
        .unwrap_or_else(|| crate::pools::DEFAULT_MAJOR.to_string());
    let (ch_platform, fallback_pv) = match identity.platform.as_deref() {
        Some(p) if p.contains("Win") => ("Windows", "15.0.0"),
        Some(p) if p.contains("Mac") => ("macOS", "15.0.0"),
        Some(p) if p.contains("Android") || p.contains("armv8l") => ("Android", "14.0.0"),
        Some(p) if p.contains("Linux") => ("Linux", "6.8.0"),
        _ => ("Windows", "15.0.0"),
    };
    let ch_platform_version = identity.ch_platform_version.as_deref().unwrap_or(fallback_pv);
    let brands = json!([
        { "brand": "Chromium", "version": major },
        { "brand": "Not A(Brand", "version": "24" },
        { "brand": "Google Chrome", "version": major }
    ]);
    let full_version_list = json!([
        { "brand": "Chromium", "version": full_version },
        { "brand": "Not A(Brand", "version": "24.0.0.0" },
        { "brand": "Google Chrome", "version": full_version }
    ]);
    (
        ch_platform.to_string(),
        ch_platform_version.to_string(),
        brands,
        full_version_list,
    )
}

/// Accept-Language coherente con el locale, p.ej. es-ES => es-ES,es;q=0.9.
fn accept_language(language: &Option<String>) -> Option<String> {
    let lang = language.as_deref().filter(|s| !s.is_empty())?;
    let base = lang.split('-').next().unwrap_or(lang);
    Some(format!("{},{};q=0.9", lang, base))
}

/// Envía una orden CDP registrando el método si falla.
///
/// Antes todos los envíos eran `let _ = ws.send(...)`: si la sesión de CDP se
/// perdía, el perfil se lanzaba con la huella REAL del host y sin shim, sin
/// ninguna señal. Para un producto antidetección ese es el peor resultado
/// posible, porque el fallo silencioso equivale a no estar protegido.
///
/// Devuelve 1 si el envío tuvo éxito, 0 si falló.
///
/// `CdpWs` es el tipo que devuelve `tungstenite::connect` desde la 0.24. Antes
/// esta función era genérica sobre `S: Read + Write` asumiendo un
/// `WebSocket<S>` propio, que ya no existe: la librería paso a exponer
/// `WebSocket<MaybeTlsStream<TcpStream>>` como tipo concreto. `Message::Text`
/// tampoco acepta ya un `&str` sino `Utf8Bytes`, de ahí el `.as_str()`.
fn cdp_send(
    ws: &mut CdpWs,
    payload: &str,
    method: &str,
    failures: &mut Vec<String>,
) -> usize {
    match ws.send(Message::Text(payload.into())) {
        Ok(_) => 1,
        Err(e) => {
            eprintln!("[cdp] no se pudo enviar {}: {}", method, e);
            failures.push(method.to_string());
            0
        }
    }
}

fn build_shim(identity: &FingerprintIdentity) -> String {
    let (ch_platform, ch_platform_version, ch_brands, ch_full_version_list) = client_hints(identity);

    let cfg = json!({
        // Solo para tools/fingerprint-lab: publica la identidad en
        // window.__krakenges. Nunca por defecto: cualquier web podía leerla.
        "debugLab": std::env::var("KRAKENGES_FP_LAB").is_ok_and(|v| v == "1"),
        "seed": identity.seed,
        "userAgent": identity.user_agent,
        "platform": identity.platform,
        "vendor": identity.vendor,
        "screenWidth": identity.screen_width,
        "screenHeight": identity.screen_height,
        "devicePixelRatio": identity.device_pixel_ratio,
        "hardwareConcurrency": identity.hardware_concurrency,
        "deviceMemory": identity.device_memory,
        "maxTouchPoints": identity.max_touch_points,
        "language": identity.language,
        "timezone": identity.timezone,
        "tzOffsetMinutes": identity.tz_offset_minutes,
        "fonts": identity.fonts,
        "chBrands": ch_brands,
        "chPlatform": ch_platform,
        "chPlatformVersion": ch_platform_version,
        "chUa": identity
            .chrome_full_version
            .as_deref()
            .map(|v| v.to_string())
            .unwrap_or_else(|| chrome_version().to_string()),
        "chFullVersionList": ch_full_version_list
    });
    let script = fingerprint_template().replace("__CONFIG_JSON__", &cfg.to_string());
    let hexa = encode_shim(&script, identity.seed);
    BOOT_JS.replace("__HEX__", &hexa).replace("__KEY_SEED__", &identity.seed.to_string())
}

/// Cifra el shim completo (stream XOR + LCG) a una cadena de hexa para que el
/// payload quede opaco en reposo: construcciones como `grep`/regex de firma o
/// análisis estático no encuentran los trucos en claro. El arrancador lo
/// descifra en runtime vía `eval` indirecto. Se pierde legibilidad, con
/// fidelidad 1:1 (mismo texto descifrado que el shim plano).
fn encode_shim(script: &str, seed: u32) -> String {
    let mut key = seed ^ 0x9E37_79B9;
    let mut hexa = String::with_capacity(script.len() * 2);
    for byte in script.bytes() {
        let mixed = byte ^ (key as u8);
        key = key.wrapping_mul(1664525).wrapping_add(1013904223);
        hexa.push_str(&format!("{:02x}", mixed));
    }
    hexa
}

/// Arrancador mínimo: descifra __HEX__ con la clave derivada del seed y evalúa
/// el resultado. No incluye ninguna técnica en claro. No deja ninguna global:
/// antes escribía window.__krakengesBoot = "ok", visible para cualquier página.
const BOOT_JS: &str = r#"(function(){try{var h="__HEX__",k=(__KEY_SEED__^0x9E3779B9)>>>0,b=[],i,s="",c;for(i=0;i<h.length;i+=2){c=parseInt(h.substr(i,2),16);b.push(c^(k&255));k=(k*1664525+1013904223)>>>0;}for(i=0;i<b.length;i++){s+=String.fromCharCode(b[i]);}(0,eval)(s);}catch(e){}})();"#;

/// Plantilla JS. El token __CONFIG_JSON__ se sustituye en Rust con JSON escapado,
/// por eso no hay problemas de llaves ni literales de template.
///
/// La plantilla vive en claro en `src/injector_template.js` SOLO como entrada de
/// build; `build.rs` la cifra (XOR + LCG) al compilar y aqui solo se incluye el
/// blob cifrado, por lo que el binario no contiene las tecnicas en texto plano
/// (strings/grep estaticos ya no las encuentran). Se descifra una vez en runtime.
include!(concat!(env!("OUT_DIR"), "/ident_enc.rs"));

fn fingerprint_template() -> &'static str {
    static T: LazyLock<String> = LazyLock::new(|| {
        let mut key = IDENT_KEY_SEED ^ 0x9E37_79B9;
        let mut bytes = Vec::with_capacity(IDENT_ENC.len());
        for &b in IDENT_ENC {
            bytes.push(b ^ (key as u8));
            key = key.wrapping_mul(1664525).wrapping_add(1013904223);
        }
        String::from_utf8(bytes).expect("template injector UTF-8")
    });
    T.as_str()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::launcher::LaunchConfig;

    /// Un perfil guardado como Windows (SO, receta del servidor y UA) se lanza
    /// con el SO del host: la huella varía por seed, pero dentro de ese SO.
    #[test]
    #[cfg(target_os = "linux")]
    fn el_so_anunciado_es_siempre_el_del_host() {
        let receta_windows = json!({
            "seed": 42, "os": "windows",
            "identity": {
                "kitId": "win11-25h2-laptop", "fullVersion": "156.0.6.87", "major": 156,
                "platform": "Win32", "uaOs": "Windows NT 10.0; Win64; x64", "platformVersion": "19.0.0",
                "screenWidth": 1920, "screenHeight": 1080, "devicePixelRatio": 1.0,
                "deviceMemory": 8.0, "cores": 16, "timezone": "America/Mexico_City", "language": "es-MX"
            }
        });
        let config = LaunchConfig {
            profile_id: "6ae6de51420dcaed7a77537a".into(),
            os: Some("windows".into()),
            fingerprint_json: Some(receta_windows.to_string()),
            ..Default::default()
        };
        let id = build_identity(&config);
        let ua = id.user_agent.clone().unwrap_or_default();
        assert!(ua.contains("X11; Linux x86_64"), "UA de otro SO: {ua}");
        assert!(id.platform.as_deref().unwrap_or("").starts_with("Linux"), "platform: {:?}", id.platform);

        // Dos perfiles distintos siguen teniendo huellas distintas.
        let otro = build_identity(&LaunchConfig { profile_id: "otro-perfil-distinto".into(), ..Default::default() });
        assert!(otro.user_agent.unwrap_or_default().contains("Linux"));
        assert_ne!(
            (id.screen_width, id.screen_height, id.seed, id.fonts.clone()),
            (otro.screen_width, otro.screen_height, otro.seed, otro.fonts.clone()),
        );
        // Núcleos y memoria quedan reales: los workers no reciben el shim.
        assert!(id.hardware_concurrency.is_none() && id.device_memory.is_none());
    }

    /// Genera el shim con una identidad de ejemplo y lo escribe a un archivo,
    /// para poder inyectarlo y validarlo en un navegador (Pixelscan/CreepJS)
    /// durante las pruebas del motor.
    #[test]
    fn dump_shim_for_validation() {
        let mut config = LaunchConfig {
            profile_id: "validation".into(),
            ..Default::default()
        };
        config.os = Some("Windows".into());
        config.profile_name = Some("Validation".into());
        config.screen_width = Some(1366);
        config.screen_height = Some(768);
        config.timezone = Some(std::env::var("KRAKENGES_TZ").unwrap_or_else(|_| "Europe/Rome".into()));
        config.locale = Some(std::env::var("KRAKENGES_LOCALE").unwrap_or_else(|_| "it-IT".into()));

        let identity = build_identity(&config);
        let shim = build_shim(&identity);
        assert!(shim.contains("__CONFIG_JSON__") == false, "config must be injected");
        assert!(shim.contains("__HEX__") == false, "hex slot must be filled");
        assert!(shim.contains("chBrands") == false, "payload must be opaque");
        assert!(shim.len() > 10000, "bootloader payload must be large");
        assert!(shim.len() < 200000, "bootloader payload reasonable size");

        // Round-trip del cifrado: el payload descifrado debe ser el shim plano.
        let script = fingerprint_template().replace("__CONFIG_JSON__", &json!({
            "seed": identity.seed, "chBrands": [{"brand": "Chromium", "version": "137"}]
        }).to_string());
        assert_eq!(decode_test(&encode_shim(&script, identity.seed), identity.seed), script);

        let out = std::env::temp_dir().join("krakenges_shim.js");
        std::fs::write(&out, &shim).expect("write shim");
        eprintln!("[dump] shim writen to {}", out.display());
    }

    fn decode_test(hexa: &str, seed: u32) -> String {
        let mut key = seed ^ 0x9E37_79B9;
        let mut bytes = Vec::with_capacity(hexa.len() / 2);
        let mut i = 0;
        while i + 1 < hexa.len() {
            let byte = u8::from_str_radix(&hexa[i..i + 2], 16).unwrap() ^ (key as u8);
            key = key.wrapping_mul(1664525).wrapping_add(1013904223);
            bytes.push(byte);
            i += 2;
        }
        String::from_utf8(bytes).expect("decode utf8")
    }

    #[test]
    fn tz_offset_static_map_looks_reasonable() {
        assert_eq!(tz_offset_minutes("europe/rome"), Some(-60));
        assert_eq!(tz_offset_minutes("america/bogota"), Some(300));
    }

    /// Regresión: el shim no parcheaba `navigator.language` ni el timezone de
    /// Intl, y los workers no reciben setLocaleOverride ni setTimezoneOverride.
    /// Un detector podía ejecutar el fingerprint dentro de un SharedWorker y
    /// obtener el idioma y el timezone REALES del host, en contraste con la
    /// página, lo que delata la emulación.
    #[test]
    fn shim_covers_language_and_timezone() {
        let shim = fingerprint_template();
        assert!(
            shim.contains("defNav('language'"),
            "el shim debe parchear navigator.language"
        );
        assert!(
            shim.contains("defNav('languages'"),
            "el shim debe parchear navigator.languages"
        );
        assert!(
            shim.contains("resolvedOptions"),
            "el shim debe corregir el timezone de Intl.DateTimeFormat"
        );
        // Y debe seguir dejando pasar canvas/WebGL como funciones nativas.
        assert!(shim.contains("WeakSet"), "el enmascarado toString debe seguir presente");
    }

    /// Regresión: `FONTS_LINUX` y `FONTS_MAC` se pasaban al shim como
    /// `C.fonts` pero el shim las ignoraba, y la de Windows no existía. La
    /// enumeración de fuentes devolvía siempre las del host.
    #[test]
    fn shim_uses_the_font_list() {
        let shim = fingerprint_template();
        assert!(
            shim.contains("C.fonts"),
            "el shim debe construir el conjunto de fuentes declaradas desde C.fonts"
        );
        assert!(
            shim.contains("measureText"),
            "el shim debe parchear measureText para simular fuentes ausentes"
        );
        assert!(
            shim.contains("fonts.check") || shim.contains("'check'"),
            "el shim debe parchear document.fonts.check"
        );
    }

    /// Las tres listas deben existir y ser suficientemente grandes: una lista de
    /// 4 fuentes la delata CreepJS como "low font count" igual que una vacía.
    #[test]
    fn font_templates_are_populated() {
        assert!(
            FONTS_WIN.len() >= 40,
            "la lista de Windows tiene solo {} fuentes",
            FONTS_WIN.len()
        );
        assert!(FONTS_MAC.len() >= 30, "macOS tiene solo {}", FONTS_MAC.len());
        assert!(FONTS_LINUX.len() >= 30, "Linux tiene solo {}", FONTS_LINUX.len());
    }

    /// Ninguna lista puede quedar vacía por descuido, y no debe haber duplicados
    /// (un duplicado infla el recuento y es un patrón raro en un sistema real).
    #[test]
    fn font_templates_have_no_duplicates() {
        for (name, list) in [
            ("windows", FONTS_WIN),
            ("macos", FONTS_MAC),
            ("linux", FONTS_LINUX),
        ] {
            let mut seen = std::collections::BTreeSet::new();
            for f in list.iter() {
                assert!(!f.trim().is_empty(), "{}: fuente vacía", name);
                assert!(
                    seen.insert(f.to_lowercase()),
                    "{}: fuente duplicada {}",
                    name,
                    f
                );
            }
        }
    }

    /// Un Windows 11 real trae Segoe UI y Consolas; si desaparecen de la lista,
    /// cualquier detector trivial lo nota.
    #[test]
    fn windows_font_template_contains_the_obvious_ones() {
        for expected in ["Segoe UI", "Consolas", "Arial", "Times New Roman", "Calibri", "Tahoma"] {
            assert!(
                FONTS_WIN.iter().any(|f| f.eq_ignore_ascii_case(expected)),
                "falta la fuente típica de Windows: {}",
                expected
            );
        }
    }

    // ── Rotación de fuentes por seed ────────────────────────────────────────
    //
    // El bug: la plantilla se aplicaba entera a todos los perfiles, así que dos
    // perfiles Windows de la misma instalación declaraban la lista byte a byte
    // idéntica. Eso no lo caza un detector de fuentes, lo caza uno que
    // correlaciona sesiones de la misma cuenta.

    /// El mismo perfil declara SIEMPRE las mismas fuentes. Sin esto, la huella
    /// cambiaría en cada arranque y el perfil no serviría para nada.
    #[test]
    fn font_set_is_stable_per_seed() {
        for os in ["win", "mac", "linux"] {
            for seed in [0u32, 1, 42, 1337, u32::MAX] {
                assert_eq!(
                    font_set(os, seed),
                    font_set(os, seed),
                    "{} con seed {} no es estable",
                    os,
                    seed
                );
            }
        }
    }

    /// Perfiles distintos del mismo SO no comparten la lista exacta. Es el
    /// test que falla si alguien vuelve a aplicar la plantilla entera.
    #[test]
    fn font_sets_differ_between_profiles() {
        for os in ["win", "mac", "linux"] {
            let base = font_set(os, 1000);
            let same = (1001..1200)
                .filter(|s| font_set(os, *s) == base)
                .count();
            assert_eq!(
                same,
                0,
                "{}: {} de 199 perfiles declaran la misma lista que el seed 1000",
                os,
                same
            );
        }
    }

    /// Diversidad real: si la rotación colapsara, doscientas combinaciones darían
    /// muy pocas listas distintas. Se exige que sobre la mitad de las posibles.
    #[test]
    fn font_rotation_has_enough_diversity() {
        for os in ["win", "mac", "linux"] {
            let unique: std::collections::BTreeSet<Vec<String>> =
                (0u32..200).map(|s| font_set(os, s)).collect();
            assert!(
                unique.len() >= 100,
                "{}: solo {} listas distintas entre 200 perfiles",
                os,
                unique.len()
            );
        }
    }

    /// El núcleo no se recorta: un Windows sin Segoe UI ni Consolas se delata
    /// más que uno que repita fuentes.
    #[test]
    fn font_set_always_contains_the_core() {
        for os in ["win", "mac", "linux"] {
            let core = font_core(os);
            for seed in 0u32..64 {
                let set = font_set(os, seed);
                for f in core {
                    assert!(
                        set.iter().any(|x| x == f),
                        "{} seed {}: falta del núcleo {}",
                        os,
                        seed,
                        f
                    );
                }
            }
        }
    }

    /// Tampoco puede quedarse corta: por debajo de ~30 fuentes, CreepJS marca
    /// 'low font count' y el recorte pasa a delatar.
    #[test]
    fn font_set_never_falls_below_the_low_font_threshold() {
        for os in ["win", "mac", "linux"] {
            let min = font_set(os, 0).len();
            for seed in 0u32..200 {
                let n = font_set(os, seed).len();
                assert!(
                    n >= 30,
                    "{} seed {}: solo {} fuentes declaradas",
                    os,
                    seed,
                    n
                );
                assert!(
                    n <= font_template(os).len(),
                    "{} seed {}: declara {} fuentes y la plantilla tiene {}",
                    os,
                    seed,
                    n,
                    font_template(os).len()
                );
            }
            assert!(min >= 30);
        }
    }

    /// Las fuentes declaradas tienen que salir de la plantilla del SO. Un
    /// 'Aptos' en un perfil Linux, o un 'PingFang SC' en uno Windows, es una
    /// combinación imposible.
    #[test]
    fn font_set_only_draws_from_its_own_template() {
        for os in ["win", "mac", "linux"] {
            let template = font_template(os);
            for seed in 0u32..64 {
                for f in font_set(os, seed) {
                    assert!(
                        template.contains(&f.as_str()),
                        "{} seed {}: '{}' no está en su plantilla",
                        os,
                        seed,
                        f
                    );
                }
            }
        }
    }

    /// Ningún perfil declara la misma fuente dos veces: un duplicado infla el
    /// recuento y es un patrón que no aparece en un sistema real.
    #[test]
    fn font_set_has_no_duplicates() {
        for os in ["win", "mac", "linux"] {
            for seed in 0u32..64 {
                let set = font_set(os, seed);
                let unique: std::collections::BTreeSet<&String> = set.iter().collect();
                assert_eq!(unique.len(), set.len(), "{} seed {}: fuentes duplicadas", os, seed);
            }
        }
    }
}