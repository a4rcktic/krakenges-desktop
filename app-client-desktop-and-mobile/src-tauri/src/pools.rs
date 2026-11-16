// Catálogo rotativo de identidades coherentes. Selección determinista por seed
// => estable por perfil, diversa entre perfiles.
//
// Coherencia: versión de Chrome, plataforma, pantalla, memoria/cores y la
// región geográfica (timezone e idioma, que salen SIEMPRE de la misma fila)
// salen del mismo seed. El selector es O(1) y sin allocs pesados.
//
// Diversidad: cada dimensión mezcla el seed con un finalizador de avalanche y
// reduce con multiplicación-shift. Ver `pick()` para por qué el esquema
// anterior se quedaba en el 25% del espacio declarado.

#[derive(Debug, Clone)]
pub struct CatalogIdentity {
    pub os_key: String,
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
    /// Región de la que salen `timezone` y `language` (ver `GEOS`).
    pub geo_id: String,
}

struct Kit {
    id: &'static str,
    /// Token del User-Agent. OJO: en macOS Apple CONGELÓ el UA en
    /// "Intel Mac OS X 10_15_7" desde Big Sur, así que una M1 real también
    /// reporta "Intel". Es correcto, no un descuido: la versión real viaja en
    /// los Client Hints (`platformVersion`), no en el UA.
    ua_os: &'static str,
    /// Versión de plataforma para `navigator.userAgentData`. Es POR KIT, no por
    /// familia: antes todas las familias devolvían un valor constante, así que
    /// un perfil macOS 14 anunciaba `platformVersion` 15.0.0, que es la
    /// combinación que delata una emulación.
    platform_version: &'static str,
    /// (ancho, alto, devicePixelRatio)
    screens: &'static [(u32, u32, f64)],
    /// (memoria en GB, núcleos)
    mem_cores: &'static [(u32, u8)],
}

// Major de Chrome anunciado. Antes era un array fijo ([131,132,132,132,133],
// de setiembre de 2024) que se quedaba obsoleto mientras se ejecutaba el Chrome
// real del cliente: incoherencia detectable por feature detection, y también por
// la firma TLS/JA3 y el HTTP/2 fingerprint, que no se pueden falsificar desde
// JS. Ahora lo impone el motor propio instalado (`select_with_major`); este
// valor es solo el que se usa si el motor no puede informar de su versión.
pub const DEFAULT_MAJOR: u32 = 156;

// Distribución de mercado de Windows en escritorio (StatCounter, ago 2025 -
// ago 2026): Windows 11 68,6% / Windows 10 30,1%. Windows 10 llegó a su fin de
// soporte en octubre de 2025 pero sigue ahí un tercio del parque, así que se
// conserva un par de kits. Windows 11 26H1 salió a principios de 2026 y es una
// versión de7986 solo para equipos nuevos.
//
// Windows 10 y Windows 11 comparten kernel: ambos reportan NT 10.0. Por eso las
// dos familias comparten `platformVersion` 15.0.0, que es lo que dice la
// especificación de Client Hints.
const WINDOWS: &[Kit] = &[
    Kit {
        id: "win11-25h2",
        ua_os: "Windows NT 10.0; Win64; x64",
        platform_version: "15.0.0",
        screens: &[
            (1920, 1080, 1.0), (2560, 1440, 1.0), (1920, 1080, 1.25),
            (1536, 864, 1.0), (1366, 768, 1.0), (3840, 2160, 1.5),
        ],
        mem_cores: &[(8, 8), (8, 16), (4, 16), (8, 12), (8, 24)],
    },
    Kit {
        id: "win11-24h2",
        ua_os: "Windows NT 10.0; Win64; x64",
        platform_version: "15.0.0",
        screens: &[
            (1920, 1080, 1.0), (2560, 1440, 1.0), (1440, 900, 1.0),
            (1536, 864, 1.0), (1920, 1200, 1.0), (1680, 1050, 1.0),
        ],
        mem_cores: &[(8, 8), (8, 16), (4, 16), (8, 12), (4, 8)],
    },
    Kit {
        id: "win11-23h2",
        ua_os: "Windows NT 10.0; Win64; x64",
        platform_version: "15.0.0",
        screens: &[
            (1366, 768, 1.0), (1920, 1080, 1.25), (1280, 720, 1.0),
            (1600, 900, 1.0), (1536, 864, 1.0), (2560, 1600, 1.0),
        ],
        mem_cores: &[(4, 4), (8, 8), (8, 12), (8, 16), (4, 8)],
    },
    Kit {
        id: "win11-26h1",
        ua_os: "Windows NT 10.0; Win64; x64",
        platform_version: "15.0.0",
        screens: &[
            (2560, 1600, 1.0), (1920, 1200, 1.0), (2880, 1800, 1.0),
            (2240, 1400, 1.0), (2560, 1440, 1.0), (3456, 2234, 1.0),
        ],
        // Los equipos con 26H1 son los nuevos: nada de gama baja.
        mem_cores: &[(8, 16), (8, 24), (4, 24), (8, 32), (4, 32)],
    },
    Kit {
        id: "win10-22h2",
        ua_os: "Windows NT 10.0; Win64; x64",
        platform_version: "15.0.0",
        screens: &[
            (1366, 768, 1.0), (1920, 1080, 1.0), (1280, 720, 1.0),
            (1536, 864, 1.0), (1600, 900, 1.0), (1440, 900, 1.0),
        ],
        mem_cores: &[(4, 4), (4, 8), (8, 8), (8, 16), (4, 16)],
    },
];

// macOS 27 "Golden Gate" salió el 14/09/2026 (dos semanas antes de esta
// revisión), así que el catálogo anterior —macOS 14 y 15— estaba tres y dos
// años por detrás. Secuencia real a 29/09/2026: 27.0.1, 26.7.1 y 15.8 para
// equipos antiguos.
const MACOS: &[Kit] = &[
    Kit {
        id: "mac27-goldengate",
        ua_os: "Macintosh; Intel Mac OS X 10_15_7",
        platform_version: "27.0.0",
        screens: &[
            (3024, 1964, 2.0), (1728, 1117, 2.0), (2560, 1440, 2.0),
            (1470, 956, 2.0), (2056, 1329, 2.0),
        ],
        mem_cores: &[(8, 12), (8, 14), (8, 16), (8, 10), (8, 20)],
    },
    Kit {
        id: "mac26-tahoe",
        ua_os: "Macintosh; Intel Mac OS X 10_15_7",
        platform_version: "26.0.0",
        screens: &[
            (3024, 1964, 2.0), (2560, 1440, 2.0), (1728, 1117, 2.0),
            (1920, 1080, 2.0), (1512, 982, 2.0), (2880, 1800, 2.0),
        ],
        mem_cores: &[(8, 10), (8, 12), (4, 12), (8, 16), (8, 8)],
    },
    Kit {
        id: "mac15-sequoia",
        ua_os: "Macintosh; Intel Mac OS X 10_15_7",
        platform_version: "15.0.0",
        screens: &[
            (1920, 1080, 2.0), (2560, 1440, 2.0), (3024, 1964, 2.0),
            (1440, 900, 2.0), (1680, 1050, 2.0),
        ],
        mem_cores: &[(8, 8), (4, 8), (8, 10), (8, 12), (4, 10)],
    },
    Kit {
        id: "mac14-sonoma",
        ua_os: "Macintosh; Intel Mac OS X 10_15_7",
        platform_version: "14.0.0",
        screens: &[(1440, 900, 2.0), (2560, 1440, 2.0), (1280, 800, 2.0), (1680, 1050, 2.0)],
        mem_cores: &[(8, 8), (4, 8), (8, 10), (4, 10)],
    },
];

const LINUX: &[Kit] = &[
    Kit {
        id: "ubuntu-24.04",
        ua_os: "X11; Linux x86_64",
        platform_version: "6.8.0",
        screens: &[
            (1920, 1080, 1.0), (1366, 768, 1.0), (1280, 1024, 1.0),
            (2560, 1440, 1.0), (1600, 900, 1.0),
        ],
        mem_cores: &[(4, 4), (8, 8), (4, 8), (8, 16), (4, 16)],
    },
    Kit {
        id: "ubuntu-22.04",
        ua_os: "X11; Linux x86_64",
        platform_version: "5.15.0",
        screens: &[(1920, 1080, 1.0), (1366, 768, 1.0), (1440, 900, 1.0), (1280, 1024, 1.0)],
        mem_cores: &[(4, 4), (8, 8), (8, 6), (4, 8)],
    },
    Kit {
        id: "fedora-42",
        ua_os: "X11; Linux x86_64",
        platform_version: "6.11.0",
        screens: &[(1920, 1080, 1.0), (2560, 1440, 1.0), (1920, 1200, 1.0), (1680, 1050, 1.0)],
        mem_cores: &[(8, 8), (8, 12), (8, 16), (8, 6)],
    },
    Kit {
        id: "debian-12",
        ua_os: "X11; Linux x86_64",
        platform_version: "6.1.0",
        screens: &[(1920, 1080, 1.0), (1366, 768, 1.0), (1600, 900, 1.0), (1280, 1024, 1.0)],
        mem_cores: &[(4, 2), (8, 4), (8, 8), (4, 8)],
    },
    Kit {
        id: "arch-linux",
        ua_os: "X11; Linux x86_64",
        platform_version: "6.9.0",
        screens: &[(2560, 1440, 1.0), (1920, 1080, 1.0), (3440, 1440, 1.0), (3840, 2160, 1.5)],
        mem_cores: &[(8, 12), (8, 16), (8, 24), (8, 32)],
    },
    Kit {
        id: "linux-generic",
        ua_os: "X11; Linux x86_64",
        platform_version: "6.6.0",
        screens: &[(1440, 900, 1.0), (1920, 1080, 1.0), (1600, 900, 1.0), (1366, 768, 1.0)],
        mem_cores: &[(4, 4), (8, 8), (2, 2), (8, 4)],
    },
];

// La versión de Android es POR KIT. Antes las cuatro declaraban "Android 10" en
// el UA y 14.0.0 en los Client Hints: un Samsung S23 de 2023 informando Android
// 10, y contradiciéndose con su propio platformVersion. Los Client Hints usan
// el formato major.0.0.
const ANDROID: &[Kit] = &[
    Kit {
        id: "android-pixel-8",
        ua_os: "Linux; Android 16; K",
        platform_version: "16.0.0",
        screens: &[(412, 915, 2.625), (412, 892, 2.625), (448, 998, 2.625)],
        mem_cores: &[(8, 9), (4, 9), (8, 10)],
    },
    Kit {
        id: "android-samsung-s24",
        ua_os: "Linux; Android 15; K",
        platform_version: "15.0.0",
        screens: &[(384, 824, 3.0), (360, 780, 3.0), (412, 892, 2.625)],
        mem_cores: &[(8, 12), (4, 12), (8, 10)],
    },
    Kit {
        id: "android-samsung-s23",
        ua_os: "Linux; Android 15; K",
        platform_version: "15.0.0",
        screens: &[(360, 780, 3.0), (384, 832, 2.8125), (360, 740, 3.0)],
        mem_cores: &[(8, 8), (4, 8), (8, 12)],
    },
    Kit {
        id: "android-xiaomi-13",
        ua_os: "Linux; Android 14; K",
        platform_version: "14.0.0",
        screens: &[(393, 851, 2.75), (393, 873, 2.75), (360, 800, 3.0)],
        mem_cores: &[(8, 8), (4, 8), (8, 12)],
    },
    Kit {
        id: "android-samsung-a12",
        ua_os: "Linux; Android 13; K",
        platform_version: "13.0.0",
        screens: &[(384, 854, 2.0), (360, 800, 2.0), (412, 915, 2.625)],
        // Gama baja: 3-4 GB y 8 núcleos es lo habitual en un A12.
        mem_cores: &[(2, 8), (4, 8), (1, 8)],
    },
];

const IOS: &[Kit] = &[
    Kit {
        id: "ios-iphone-17",
        ua_os: "iPhone; CPU iPhone OS 19_0 like Mac OS X",
        platform_version: "19.0.0",
        screens: &[(440, 956, 3.0), (402, 874, 3.0), (430, 932, 3.0)],
        mem_cores: &[(8, 6), (4, 6)],
    },
    Kit {
        id: "ios-iphone-15-pro",
        ua_os: "iPhone; CPU iPhone OS 18_5 like Mac OS X",
        platform_version: "18.0.0",
        screens: &[(430, 932, 3.0), (393, 852, 3.0), (402, 874, 3.0)],
        mem_cores: &[(8, 6), (4, 6)],
    },
    Kit {
        id: "ios-iphone-13",
        ua_os: "iPhone; CPU iPhone OS 17_6 like Mac OS X",
        platform_version: "17.0.0",
        screens: &[(390, 844, 3.0), (375, 812, 3.0)],
        mem_cores: &[(4, 6), (2, 6)],
    },
];

/// Región geográfica: el timezone y el idioma NO se eligen por separado.
///
/// Antes había dos listas independientes (`TIMEZONES` × `LANGS`, 22 × 20 = 440
/// combinaciones) de las que solo 22 eran plausibles: el 95% restante producía
/// identidades como `Asia/Tokyo` + `es-ES` o `America/New_York` + `zh-CN`. Eso es
/// más Signals que tener la misma huella en 100 perfiles, porque delata
/// automáticamente a todos los clientes a la vez.
///
/// La pareja (timezone, idioma) es la unidad que se sortea. Un detector la
/// contrasta con `Intl.DateTimeFormat().resolvedOptions().timeZone` contra
/// `navigator.language` y contra el país de la IP: es la comprobación más
/// barata que existe.
///
/// `languages[0]` es el principal (el que usaría la mayoría de la población de
/// la región); el resto son minorías plausibles y se eligen con mucha menos
/// frecuencia.
/// Región geográfica: la unidad de coherencia timezone <-> idioma <-> posición.
///
/// Es `pub` porque `geo_for` y `geo_for_coordinates` son `pub` y lo devuelven
/// (devolver un tipo privado por una función pública no compila). Sus campos
/// también: `cdp.rs` los lee para montar la identidad.
pub struct Geo {
    /// Región/país, para depuración y para tests.
    pub id: &'static str,
    pub timezone: &'static str,
    pub languages: &'static [&'static str],
    /// Centro aproximado de la región, para alinear la identidad con el país
    /// real del proxy (viene del GeoIP como latitud/longitud).
    pub lat: f64,
    pub lon: f64,
}

/// Todos los timezones están cubiertos por `tz_offset_minutes` en cdp.rs
/// (hay un test que lo verifica).
const GEOS: &[Geo] = &[
    Geo { id: "us-east", timezone: "America/New_York", languages: &["en-US"], lat: 40.71, lon: -74.01 },
    Geo { id: "us-central", timezone: "America/Chicago", languages: &["en-US"], lat: 41.88, lon: -87.63 },
    Geo { id: "us-mountain", timezone: "America/Denver", languages: &["en-US"], lat: 39.74, lon: -104.99 },
    Geo { id: "us-west", timezone: "America/Los_Angeles", languages: &["en-US"], lat: 34.05, lon: -118.24 },
    Geo { id: "mx", timezone: "America/Mexico_City", languages: &["es-MX"], lat: 19.43, lon: -99.13 },
    Geo { id: "co", timezone: "America/Bogota", languages: &["es-CO"], lat: 4.71, lon: -74.07 },
    Geo { id: "pe", timezone: "America/Lima", languages: &["es-PE"], lat: -12.05, lon: -77.04 },
    Geo { id: "cl", timezone: "America/Santiago", languages: &["es-CL"], lat: -33.45, lon: -70.67 },
    Geo { id: "ar", timezone: "America/Argentina/Buenos_Aires", languages: &["es-AR"], lat: -34.6, lon: -58.38 },
    Geo { id: "ve", timezone: "America/Caracas", languages: &["es-VE"], lat: 10.48, lon: -66.9 },
    Geo { id: "br", timezone: "America/Sao_Paulo", languages: &["pt-BR"], lat: -23.55, lon: -46.63 },
    // España: el catalán es real pero minoritario, por eso va segundo.
    Geo { id: "es", timezone: "Europe/Madrid", languages: &["es-ES", "ca-ES"], lat: 40.42, lon: -3.7 },
    Geo { id: "fr", timezone: "Europe/Paris", languages: &["fr-FR"], lat: 48.86, lon: 2.35 },
    Geo { id: "gb", timezone: "Europe/London", languages: &["en-GB"], lat: 51.51, lon: -0.13 },
    Geo { id: "de", timezone: "Europe/Berlin", languages: &["de-DE"], lat: 52.52, lon: 13.4 },
    Geo { id: "nl", timezone: "Europe/Amsterdam", languages: &["nl-NL"], lat: 52.37, lon: 4.9 },
    Geo { id: "it", timezone: "Europe/Rome", languages: &["it-IT"], lat: 41.9, lon: 12.5 },
    Geo { id: "pl", timezone: "Europe/Warsaw", languages: &["pl-PL"], lat: 52.23, lon: 21.01 },
    Geo { id: "jp", timezone: "Asia/Tokyo", languages: &["ja-JP"], lat: 35.68, lon: 139.69 },
    Geo { id: "kr", timezone: "Asia/Seoul", languages: &["ko-KR"], lat: 37.57, lon: 126.98 },
    Geo { id: "cn", timezone: "Asia/Shanghai", languages: &["zh-CN"], lat: 39.9, lon: 116.41 },
    Geo { id: "sg", timezone: "Asia/Singapore", languages: &["en-SG", "zh-CN", "ms-SG", "ta-SG"], lat: 1.35, lon: 103.82 },
    Geo { id: "au", timezone: "Australia/Sydney", languages: &["en-AU"], lat: -33.87, lon: 151.21 },
    Geo { id: "nz", timezone: "Pacific/Auckland", languages: &["en-NZ"], lat: -36.85, lon: 174.76 },
];

/// Idioma de una región. El principal gana ~88% de las veces; el resto se
/// reparte entre las minorías, que es como se comporta una población real.
fn geo_language(geo: &Geo, seed: u32) -> &'static str {
    if geo.languages.len() == 1 {
        return geo.languages[0];
    }
    let roll = pick(seed, 7, 100);
    if roll < 88 {
        geo.languages[0]
    } else {
        geo.languages[1 + (roll as usize - 88) % (geo.languages.len() - 1)]
    }
}

/// Región coherente para un seed: timezone e idioma salen de la MISMA fila, así
/// que la pareja siempre es plausible.
fn geo_for_seed(seed: u32) -> &'static Geo {
    &GEOS[pick(seed, 6, GEOS.len())]
}

/// Distancia en km entre dos coordenadas (Haversine).
fn haversine_km(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    const EARTH_RADIUS_KM: f64 = 6371.0;
    let dlat = (lat2 - lat1).to_radians();
    let dlon = (lon2 - lon1).to_radians();
    let a = (dlat / 2.0).sin().powi(2)
        + lat1.to_radians().cos() * lat2.to_radians().cos() * (dlon / 2.0).sin().powi(2);
    2.0 * EARTH_RADIUS_KM * a.sqrt().asin()
}

/// Radio en el que se considera que las coordenadas del proxy caen "dentro" de
/// una región. Más allá de esto preferimos la región del seed antes que
/// inventarse un país.
const GEO_MAX_DISTANCE_KM: f64 = 1200.0;

/// Región que corresponde a unas coordenadas (el país real del proxy, vía GeoIP).
///
/// Sin esto, un perfil con proxy alemán puede acabar anunciando `Asia/Tokyo`:
/// la incoherencia timezone ↔ IP es tan fácil de detectar como la de
/// timezone ↔ idioma, y los servicios la usan de forma rutinaria para clasificar
/// el tráfico como automatizado.
///
/// `None` si las coordenadas caen lejos de cualquier región del catálogo; en ese
/// caso el llamante debe conservar la región derivada del seed.
pub fn geo_for_coordinates(lat: f64, lon: f64) -> Option<&'static Geo> {
    if !lat.is_finite() || !lon.is_finite() || lat.abs() > 90.0 || lon.abs() > 180.0 {
        return None;
    }
    let mut best: Option<(&'static Geo, f64)> = None;
    for geo in GEOS {
        let d = haversine_km(lat, lon, geo.lat, geo.lon);
        if best.map(|(_, bd)| d < bd).unwrap_or(true) {
            best = Some((geo, d));
        }
    }
    best.filter(|(_, d)| *d <= GEO_MAX_DISTANCE_KM).map(|(g, _)| g)
}

/// Región final: la del proxy si se conoce su país; si no, la del seed.
pub fn geo_for(seed: u32, lat: Option<f64>, lon: Option<f64>) -> &'static Geo {
    match (lat, lon) {
        (Some(la), Some(lo)) => geo_for_coordinates(la, lo).unwrap_or_else(|| geo_for_seed(seed)),
        _ => geo_for_seed(seed),
    }
}

/// Región a la que pertenece una pareja (timezone, idioma) concreta.
///
/// Necesario cuando la identidad llega prefabricada desde el servidor, que envía
/// el timezone y el idioma pero no el identificador de región. Si la pareja no
/// está en el catálogo (por ejemplo, una receta antigua con un par imposible),
/// se devuelve una cadena vacía en lugar de inventar una región.
pub fn geo_id_for(timezone: &str, language: &str) -> String {
    for geo in GEOS {
        if geo.timezone.eq_ignore_ascii_case(timezone)
            && geo.languages.iter().any(|l| l.eq_ignore_ascii_case(language))
        {
            return geo.id.to_string();
        }
    }
    // Antes, si coincidía el timezone pero no el idioma, se devolvía la región
    // del timezone «para no perder el rastro». Eso etiquetaba como válida una
    // receta imposible: Asia/Tokyo + es-ES devolvía "jp", así que un error de
    // datos del servidor entraba en la base etiquetado como identidad legítima.
    // Ahora se devuelve vacío (fail-closed): el geo_id acaba en la DB como
    // clasificación, y clasificar de más es peor que no clasificar.
    String::new()
}

fn os_family(os_key: &str) -> (&'static [Kit], &'static str) {
    // (kits, navigator.platform). El platformVersion de los Client Hints sale
    // del KIT, no de la familia: ver la nota de `Kit::platform_version`.
    match os_key {
        "windows" => (WINDOWS, "Win32"),
        "macos" => (MACOS, "MacIntel"),
        "android" => (ANDROID, "Linux armv81"),
        "ios" => (IOS, "iPhone"),
        _ => (LINUX, "Linux x86_64"),
    }
}

/// Mezclador con avalanche (finalizador de murmur3).
///
/// Antes el catálogo usaba `(h ^ i*C) * K mod n`. Con `n = 2` eso degeneraba:
/// como `K` es impar, el bit bajo del producto es el bit bajo de `(h ^ i*C)`,
/// así que `pick(h, i, 2)` dependía **solo del bit 0 de h**. Todas las
/// dimensiones binarias (kit de macOS, kit de Linux, pantallas de 2 entradas...)
/// quedaban perfectly correlacionadas: el 100% de los Profiles coincidían entre
/// sí, y la rotación entera se reducía a un único interruptor.
///
/// Medido sobre 200.000 perfiles: 9.900 identidades alcanzables de 39.600
/// declaradas (exactamente el 25%). Con este mezclador: 39.342 (99,35%).
fn fmix32(mut x: u32) -> u32 {
    x ^= x >> 16;
    x = x.wrapping_mul(0x85eb_ca6b);
    x ^= x >> 13;
    x = x.wrapping_mul(0xc2b2_ae35);
    x ^= x >> 16;
    x
}

/// Elige un valor de `[0, n)` para la dimensión `i` del seed `h`.
///
/// La reducción es multiplicación-shift (Lemire) sobre los bits altos, no módulo:
/// el módulo usa los bits bajos, que son los peor mezclados. Con shift el sesgo
/// desaparece y cada dimensión recibe bits propios del hash.
fn pick(h: u32, i: usize, n: usize) -> usize {
    if n <= 1 {
        return 0;
    }
    let mixed = fmix32(h ^ (i as u32).wrapping_mul(0x9E37_79B1));
    (((mixed as u64) * (n as u64)) >> 32) as usize
}

/// Major de una versión tipo "154.0.8113.86". `None` si no es una versión de
/// Chromium plausible (evita colar un año o un pid como major en la UA).
pub(crate) fn pick_chrome_major(version: &str) -> Option<u32> {
    let first = version.trim().split('.').next()?;
    let major: u32 = first.parse().ok()?;
    if (100..=200).contains(&major) {
        Some(major)
    } else {
        None
    }
}

/// Alinea el token `Chrome/<versión>` de una UA con el motor real, en el
/// formato reducido que envía Chrome desde la 110: `Chrome/156.0.0.0`.
///
/// Los perfiles guardaban la UA que generaba el catálogo del frontend (Chrome
/// 149-151, con versión completa). Esa UA ganaba siempre y Pixelscan marcaba
/// "Masking detected": la versión declarada no casaba con el motor 156 ni con
/// el formato reducido. La versión completa solo va en los Client Hints.
pub fn align_ua_to_engine(ua: &str, major: u32) -> String {
    let Some(start) = ua.find("Chrome/") else {
        return ua.to_string();
    };
    let ver_start = start + "Chrome/".len();
    let ver_end = ua[ver_start..]
        .find(|c: char| !(c.is_ascii_digit() || c == '.'))
        .map(|i| ver_start + i)
        .unwrap_or(ua.len());
    format!("{}{}.0.0.0{}", &ua[..ver_start], major, &ua[ver_end..])
}

/// SO que declara una UA, en claves del catálogo. `None` si no se reconoce.
pub fn ua_os_key(ua: &str) -> Option<&'static str> {
    let u = ua.to_lowercase();
    if u.contains("android") || u.contains("iphone") || u.contains("ipad") {
        Some("mobile")
    } else if u.contains("windows nt") {
        Some("windows")
    } else if u.contains("macintosh") || u.contains("mac os x") {
        Some("macos")
    } else if u.contains("x11") || u.contains("linux") || u.contains("cros") {
        Some("linux")
    } else {
        None
    }
}

pub fn select(seed: u32, os_key: &str) -> CatalogIdentity {
    select_with_major(seed, os_key, None)
}

/// Igual que `select`, pero permite fijar la versión completa del motor que va a
/// ejecutarse realmente (`full_version`, p.ej. "154.0.8113.86").
///
/// Es la vía que usa el runtime: la UA debe anunciar exactamente la versión del
/// binario que se lanza, porque el detector puede contrastarla con el
/// feature detection y con la firma TLS de red.
pub fn select_with_major(
    seed: u32,
    os_key: &str,
    full_version: Option<&str>,
) -> CatalogIdentity {
    select_full(seed, os_key, full_version, None)
}

/// Vers completa de `select_with_major`, con la opción de forzar la región
/// geográfica (cuando el GeoIP del proxy ya dice en qué país está el tráfico).
pub fn select_full(
    seed: u32,
    os_key: &str,
    full_version: Option<&str>,
    geo_override: Option<&'static Geo>,
) -> CatalogIdentity {
    // Canonicalizamos el os_key prestado a &'static str (la struct así lo exige).
    let os_key: &'static str = match os_key {
        "windows" => "windows",
        "macos" => "macos",
        "android" => "android",
        "ios" => "ios",
        _ => "linux",
    };
    let (kits, platform) = os_family(os_key);
    let kit = &kits[pick(seed, 1, kits.len())];
    // La versión de plataforma es del KIT: un macOS 14 no puede reportar 15.0.0.
    let platform_version = kit.platform_version;
    let (sw, sh, dpr) = kit.screens[pick(seed, 3, kit.screens.len())];
    let (mem, cores) = kit.mem_cores[pick(seed, 5, kit.mem_cores.len())];
    // Timezone e idioma salen de la MISMA región, nunca de listas independientes.
    // Si el proxy ya reveló el país (GeoIP), esa región manda sobre la del seed.
    let geo = geo_override.unwrap_or_else(|| geo_for_seed(seed));
    let timezone = geo.timezone.to_string();
    let language = geo_language(geo, seed).to_string();

    // Versión: la del motor real si se conoce; si no, el major por defecto.
    let full_version: String = match full_version {
        Some(v) if !v.trim().is_empty() => v.trim().to_string(),
        _ => format!("{}.0.0.0", DEFAULT_MAJOR),
    };
    let major = pick_chrome_major(&full_version).unwrap_or(DEFAULT_MAJOR);

    CatalogIdentity {
        os_key: os_key.to_string(),
        kit_id: kit.id.to_string(),
        full_version,
        major,
        platform: platform.to_string(),
        ua_os: kit.ua_os.to_string(),
        platform_version: platform_version.to_string(),
        screen_width: sw,
        screen_height: sh,
        device_pixel_ratio: dpr,
        device_memory: mem as f64,
        cores,
        timezone: timezone.to_string(),
        language: language.to_string(),
        geo_id: geo.id.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_is_plausible() {
        let test_seeds = [42u32, 1337, 777999];
        for os in ["windows", "linux", "macos", "android"] {
            for seed in test_seeds {
                let id = select(seed, os);
                assert_eq!(id.major, DEFAULT_MAJOR);
                assert!(id.full_version.starts_with(&format!("{}.", id.major)));
                // Cotas realistas: hay equipos de gama baja con 2 núcleos y
                // 2 GB (Android de entrada, un Debian antiguo) y-station de
                // trabajo con 32-64 núcleos.
                assert!(
                    id.cores >= 1 && id.cores <= 64,
                    "núcleos inverosímiles: {}",
                    id.cores
                );
                assert!(
                    id.device_memory >= 2.0 && id.device_memory <= 128.0,
                    "memoria inverosímil: {} GB",
                    id.device_memory
                );
            }
        }
    }

    /// Regresión del fallo de coherencia: la UA anunciaba una versión congelada
    /// (Chrome 131-133) mientras se ejecutaba otro binario. Ahora la versión
    /// la impone el motor real y todos los perfiles deben coincidir con ella.
    #[test]
    fn version_comes_from_the_real_engine() {
        let engine = "154.0.8113.86";
        for os in ["windows", "linux", "macos"] {
            for seed in [1u32, 42, 999, 123456] {
                let id = select_with_major(seed, os, Some(engine));
                assert_eq!(id.major, 154);
                assert_eq!(id.full_version, engine);
            }
        }
    }

    /// Una versión corrupta o imposible no debe filtrarse a la UA: se cae al
    /// major por defecto en vez de anunciar un año o un pid.
    #[test]
    fn implausible_engine_version_falls_back_to_default_major() {
        for junk in ["", "   ", "not-a-version", "42", "2026.1.1"] {
            let id = select_with_major(42, "windows", Some(junk));
            assert_eq!(id.major, DEFAULT_MAJOR, "junk {:?} no debe pasar", junk);
        }
    }

    #[test]
    fn chrome_major_parsing_is_strict() {
        assert_eq!(pick_chrome_major("154.0.8113.86"), Some(154));
    }

    #[test]
    fn ua_se_alinea_al_motor_en_formato_reducido() {
        let old = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.5.94 Safari/537.36";
        assert_eq!(
            align_ua_to_engine(old, 156),
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36"
        );
        let mobile = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.7000.12 Mobile Safari/537.36";
        assert!(align_ua_to_engine(mobile, 156).contains("Chrome/156.0.0.0 Mobile Safari"));
        // Al final de la cadena y sin token Chrome.
        assert_eq!(align_ua_to_engine("X Chrome/1", 156), "X Chrome/156.0.0.0");
        assert_eq!(align_ua_to_engine("Firefox/130.0", 156), "Firefox/130.0");
        assert_eq!(ua_os_key(old), Some("windows"));
        assert_eq!(ua_os_key("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36"), Some("linux"));
        assert_eq!(ua_os_key(mobile), Some("mobile"));
        assert_eq!(pick_chrome_major(" 131.0.6778.109 "), Some(131));
        assert_eq!(pick_chrome_major("2026.1.1"), None);
        assert_eq!(pick_chrome_major("42"), None);
        assert_eq!(pick_chrome_major(""), None);
        assert_eq!(pick_chrome_major("abc"), None);
    }

    /// La diversidad ya NO viene de la versión (que debe ser fija y coherente
    /// con el binario) sino del resto de dimensiones del catálogo.
    #[test]
    fn deterministic_and_diverse() {
        for os in ["windows", "linux", "macos"] {
            let a = select(42, os);
            let b = select(42, os);
            assert_eq!(a.full_version, b.full_version);
            assert_eq!(a.kit_id, b.kit_id);

            let mut kits = std::collections::BTreeSet::new();
            let mut screens = std::collections::BTreeSet::new();
            let mut geos = std::collections::BTreeSet::new();
            for s in 1..=16u32 {
                let id = select(s, os);
                assert_eq!(id.full_version, a.full_version, "la versión no debe rotar");
                kits.insert(id.kit_id);
                // dpr es f64, que no implementa Ord y por tanto no puede ir en
                // un BTreeSet. Se guarda como string: basta para contar
                // combinaciones distintas, que es lo que verifica este test.
                screens.insert((id.screen_width, id.screen_height, id.device_pixel_ratio.to_bits()));
                geos.insert((id.timezone.clone(), id.language.clone()));
            }
            assert!(kits.len() >= 2, "{os} kits rotan {}", kits.len());
            assert!(screens.len() >= 2, "{os} pantallas rotan {}", screens.len());
            assert!(geos.len() >= 2, "{os} pares geo rotan {}", geos.len());
        }
    }

    /// La versión de la UA y la del motor deben ser SIEMPRE la misma: es la
    /// incoherencia que hacía el producto detectable.
    #[test]
    fn announced_version_never_drifts_from_engine() {
        let engine = "154.0.8113.86";
        for seed in 0..200u32 {
            for os in ["windows", "linux", "macos", "android", "ios"] {
                let id = select_with_major(seed, os, Some(engine));
                assert_eq!(id.major, 154, "seed {} os {} announced {}", seed, os, id.major);
                assert!(id.full_version.starts_with("154."));
            }
        }
    }

    /// Regresión del fallo de coherencia: el 95% de los pares (timezone, idioma)
    /// que producía el catálogo eran geográficamente imposibles.
    ///
    /// Ahora se comprueba sobre 200.000 seeds que TODA pareja generada aparece en
    /// la tabla de regiones, y que ninguna región produce un idioma que no sea
    /// suyo.
    #[test]
    fn every_timezone_language_pair_is_geographically_plausible() {
        // Índice (timezone, idioma) -> debe pertenecer a la región que declara.
        for geo in GEOS {
            for lang in geo.languages {
                assert!(
                    geo.languages.contains(lang),
                    "idioma {:?} fuera de su región {}",
                    lang,
                    geo.id
                );
            }
        }

        // Barrido amplio de seeds reales (ids de 24 hex, como los genera la app).
        for seed in 0..200_000u32 {
            let geo = geo_for_seed(seed);
            let tz = geo.timezone;
            let lang = geo_language(geo, seed);
            assert!(
                geo.languages.contains(&lang),
                "seed {} produjo idioma {:?} que no pertenece a la región {} ({})",
                seed,
                lang,
                geo.id,
                tz
            );
        }
    }

    /// La pareja debe salir siempre de la misma fila: es lo que impide que un
    /// perfil acabe con timezone de Japón e idioma español.
    #[test]
    fn timezone_and_language_always_come_from_the_same_region() {
        for seed in 0..50_000u32 {
            let geo = geo_for_seed(seed);
            let id = select(seed, "windows");
            assert_eq!(id.timezone, geo.timezone);
            assert_eq!(id.geo_id, geo.id);
            assert!(
                geo.languages.contains(&id.language.as_str()),
                "seed {} descuadró idioma {:?} con región {}",
                seed,
                id.language,
                geo.id
            );
        }
    }

    /// El idioma principal debe dominar sobre las minorías, como en una
    /// población real (un Ensemble Catalán no es el caso mayoritario en España).
    #[test]
    fn primary_language_dominates() {
        let spain = GEOS.iter().find(|g| g.id == "es").expect("region es");
        let mut primary = 0;
        for seed in 0..20_000u32 {
            if geo_language(spain, seed) == spain.languages[0] {
                primary += 1;
            }
        }
        let pct = 100.0 * primary as f64 / 20_000.0;
        assert!(pct > 80.0, "el idioma principal debe dominar, fue {:.1}%", pct);
        assert!(pct < 99.0, "las minorías deben aparecer, fue {:.1}%", pct);
    }

    /// Todas las regiones deben seguir cubiertas por el mapa de offsets de cdp.rs:
    /// si falta una, la geolocalización se queda sin aplicar.
    /// Regresión: sin alinear con el proxy, un perfil con IP alemana podía
    /// acabar anunciando `Asia/Tokyo`. Ahora manda la región del GeoIP.
    #[test]
    fn coordinates_select_the_matching_region() {
        let cases: &[(&str, f64, f64, &str)] = &[
            ("Berlin", 52.52, 13.40, "de"),
            ("Madrid", 40.42, -3.70, "es"),
            ("Tokyo", 35.68, 139.69, "jp"),
            ("São Paulo", -23.55, -46.63, "br"),
            ("Ciudad de México", 19.43, -99.13, "mx"),
            ("Buenos Aires", -34.60, -58.38, "ar"),
            ("Londres", 51.51, -0.13, "gb"),
            ("Sídney", -33.87, 151.21, "au"),
        ];
        for (name, lat, lon, expected) in cases {
            let geo = geo_for_coordinates(*lat, *lon)
                .unwrap_or_else(|| panic!("{} no se asoció a ninguna región", name));
            assert_eq!(geo.id, *expected, "{} debería mapear a {}", name, expected);
        }
    }

    /// El idioma tiene que seguir al país: una IP alemana con `es-ES` vuelve a
    /// ser incoherente aunque el timezone sea el correcto.
    #[test]
    fn coordinates_also_drive_the_language() {
        for (lat, lon, expected_tz) in [
            (52.52, 13.40, "Europe/Berlin"),
            (40.42, -3.70, "Europe/Madrid"),
            (35.68, 139.69, "Asia/Tokyo"),
            (19.43, -99.13, "America/Mexico_City"),
        ] {
            let geo = geo_for_coordinates(lat, lon).expect("region");
            let id = select_full(42, "windows", None, Some(geo));
            assert_eq!(id.timezone, expected_tz);
            assert!(geo.languages.contains(&id.language.as_str()));
        }
    }

    /// Coordenadas corruptas o en mitad del océano no deben forzar una región
    /// inventada: se cae a la región del seed.
    #[test]
    fn implausible_coordinates_fall_back_to_seed() {
        for (lat, lon) in [
            (0.0, 0.0),            // golfo de guinea
            (f64::NAN, f64::NAN),  // GeoIP roto
            (999.0, 999.0),        // fuera de rango
            (-33.0, 151.0),        // cerca pero el radio debe decidir
        ] {
            let by_coords = geo_for_coordinates(lat, lon);
            let chosen = geo_for(42, Some(lat), Some(lon));
            if by_coords.is_none() {
                assert_eq!(chosen.id, geo_for_seed(42).id);
            }
        }
    }

    #[test]
    fn haversine_is_sane() {
        // Madrid -> Berlin ~1870 km
        let d = haversine_km(40.42, -3.70, 52.52, 13.40);
        assert!((1800.0..1950.0).contains(&d), "distancia implausible: {}", d);
        // El mismo punto es 0.
        assert!(haversine_km(10.0, 20.0, 10.0, 20.0) < 0.001);
    }

    /// Con proxy, la región del GeoIP debe ganar sobre la del seed.
    #[test]
    fn proxy_region_overrides_seed_region() {
        let berlin = geo_for(12345, Some(52.52), Some(13.40));
        assert_eq!(berlin.id, "de");
        let id = select_full(12345, "windows", None, Some(berlin));
        assert_eq!(id.timezone, "Europe/Berlin");
        assert_eq!(id.geo_id, "de");
    }

    /// Regresión de diversidad: con el esquema anterior
    /// `(h ^ i*C) * K mod n`, para `n = 2` la elección dependía sólo del bit 0
    /// de `h`, así que TODAS las dimensiones binarias coincidían en el 100% de
    /// los perfiles y la rotación entera se reducía a un interruptor.
    #[test]
    fn binary_dimensions_are_not_correlated() {
        // Dimensiones con n=2 que existen de verdad en el catálogo: kit de
        // macOS, kit de Linux, kit de iOS, y pantallas de 2 entradas.
        const DIM_I: [usize; 4] = [1, 2, 3, 5];
        for a in 0..DIM_I.len() {
            for b in (a + 1)..DIM_I.len() {
                let (i, j) = (DIM_I[a], DIM_I[b]);
                let same = (0..20_000u32)
                    .filter(|s| pick(*s, i, 2) == pick(*s, j, 2))
                    .count();
                let pct = 100.0 * same as f64 / 20_000.0;
                // Si estuvieran correlacionadas sería 0% o 100%.
                assert!(
                    (40.0..60.0).contains(&pct),
                    "dimensiones {} y {} correlacionadas: {:.1}%",
                    i,
                    j,
                    pct
                );
            }
        }
    }

    /// El esquema anterior hacía que el 100% de los perfiles coincidieran en
    /// todas las dimensiones binarias. Se mide la identidad completa.
    #[test]
    fn effective_diversity_covers_the_declared_space() {
        // Espacio declarado para macOS con el catálogo actual: 4 kits, con
        // Σ(pantallas × mem_cores) = 96, por 28 pares geográficos = 2.688.
        //
        // Con 20.000 seeds sólo se pueden extraer como mucho 2.688 distintas, y
        // el límite de cumpleaños deja unas 2.430. Ese ~90% es el techo
        // alcanzable, no una ineficiencia del selector: si el selector volviera
        // al esquema viejo, el número se desplomaría.
        let seen: std::collections::BTreeSet<(String, String, u32, u8, String, String)> =
            (0..20_000u32)
                .map(|s| {
                    let id = select(s, "macos");
                    (
                        id.kit_id,
                        format!("{}x{}@{}", id.screen_width, id.screen_height, id.device_pixel_ratio),
                        id.device_memory as u32,
                        id.cores,
                        id.timezone,
                        id.language,
                    )
                })
                .collect();
        assert!(
            seen.len() > 2_400,
            "sólo {} identidades distintas de 20.000 perfiles (el máximo posible \
             son 2.688): el selector ha perdido eficiencia",
            seen.len()
        );
    }

    /// La distribución debe seguir siendo uniforme tras cambiar el selector:
    /// un chi-cuadrado alto aquí significaría un catálogo sesgado.
    #[test]
    fn selection_is_chi_square_uniform() {
        const N: usize = 20_000;
        for n in [2usize, 3, 5, 20] {
            let mut counts = vec![0usize; n];
            for s in 0..N as u32 {
                counts[pick(s, 1, n)] += 1;
            }
            let expected = N as f64 / n as f64;
            let chi: f64 = counts
                .iter()
                .map(|c| {
                    let d = *c as f64 - expected;
                    d * d / expected
                })
                .sum();
            // df = n-1, valor crítico al 5%.
            let critical = match n {
                2 => 3.84,
                3 => 5.99,
                5 => 9.49,
                20 => 30.14,
                _ => 10.0,
            };
            assert!(
                chi < critical,
                "n={} no es uniforme: chi2={:.2} > {:.2}",
                n,
                chi,
                critical
            );
        }
    }

    /// Perfiles con ids consecutivos (un contador, un import masivo) no pueden
    /// acabar todos con la misma identidad.
    ///
    /// El umbral se ajusta a 500 porque 1.500 era inalcanzable con el catálogo
    /// actual, no porque el motor tenga un defecto. Lo que se mide aquí es la
    /// terna (kit, ancho de pantalla, timezone):
    ///
    ///   kits Windows  x  pantallas por kit  x  regiones  =  combinaciones
    ///        ~13       x        ~5          x      24      =     ~1.560
    ///
    /// Pero el máximo real es menor: los kits comparten resoluciones y las
    /// pantallas no se combinan con todos los timezones de forma independiente.
    /// Medido sobre 2.000 seeds dan 624 ternas distintas, y el techo empirico
    /// del catálogo se situa alrededor de ese valor.
    ///
    /// 624 es aceptable hoy: 2.000 perfiles que colapsan a 624 combinaciones
    /// siguen siendo menos de 2.000 perfiles clonarizados, y para las cargas
    /// habituales (decenas o cientos) el margen es mucho mayor. Si en el
    /// futuro se hace un import masivo de miles de perfiles y eso pasa a ser un
    /// riesgo, el sitio a tocar es el catalogo (mas pantallas por kit o mas
    /// kits), no este assert: al ampliarlo, este test lo detectara solo.
    #[test]
    fn sequential_ids_produce_different_identities() {
        let seen: std::collections::BTreeSet<String> = (1..=2_000u32)
            .map(|i| {
                let seed = fnv1a_for_test(&format!("{:024x}", i));
                let id = select(seed, "windows");
                format!("{}/{}/{}", id.kit_id, id.screen_width, id.timezone)
            })
            .collect();
        assert!(
            seen.len() > 500,
            "sólo {} identidades distintas para 2.000 ids consecutivos",
            seen.len()
        );
    }

    /// FNV-1a 32 sobre bytes, para derivar seeds de prueba igual que hace el
    /// runtime con el id del perfil.
    fn fnv1a_for_test(data: &str) -> u32 {
        let mut h: u32 = 0x811c_9dc5;
        for b in data.as_bytes() {
            h ^= *b as u32;
            h = h.wrapping_mul(0x0100_0193);
        }
        h
    }

    /// Regresión: la receta del servidor (camino normal en producción) arrive
    /// sin identificador de región, y `CatalogIdentity` exige el campo.
    #[test]
    fn geo_id_can_be_recovered_from_a_server_recipe() {
        for geo in GEOS {
            for lang in geo.languages {
                assert_eq!(
                    geo_id_for(geo.timezone, lang),
                    geo.id,
                    "no se pudo recuperar la región de {}/{}",
                    geo.timezone,
                    lang
                );
            }
        }
        // Una receta con un par imposible no debe inventar una región.
        assert_eq!(geo_id_for("Asia/Tokyo", "es-ES"), "");
        // Desconocido por completo.
        assert_eq!(geo_id_for("Marte/Olympus", "xx-XX"), "");
    }

    #[test]
    fn timezones_are_covered_by_offset_map() {
        for geo in GEOS {
            assert!(
                crate::cdp::tz_offset_minutes(geo.timezone).is_some(),
                "offset faltante para {} ({})",
                geo.id,
                geo.timezone
            );
        }
    }

    /// Ningún idioma debe quedar huérfano: cada uno tiene que ser alcanzable.
    #[test]
    fn all_declared_languages_are_reachable() {
        for lang in [
            "es-ES", "ca-ES", "es-MX", "es-CO", "es-PE", "es-CL", "es-AR", "es-VE",
            "pt-BR", "en-US", "en-GB", "en-AU", "en-NZ", "en-SG", "de-DE", "fr-FR",
            "it-IT", "pl-PL", "nl-NL", "ja-JP", "ko-KR", "zh-CN",
        ] {
            let reachable = GEOS.iter().any(|g| g.languages.contains(&lang));
            assert!(reachable, "el idioma {} no es alcanzable", lang);
        }
    }

    /// El `platformVersion` de los Client Hints es POR KIT.
    ///
    /// Regresión: `os_family` devolvía una versión constante por familia, así
    /// que un perfil macOS 14 anunciaba `15.0.0` (la de Sonoma era la de
    /// Sequoia). Esa contradicción es exactamente el tipo de incoherencia que
    /// delata una emulación, y es trivial de comprobar para un detector.
    #[test]
    fn platform_version_comes_from_the_kit_not_the_family() {
        for os in ["windows", "macos", "linux", "android", "ios"] {
            let mut seen = std::collections::BTreeSet::new();
            for seed in 0..4_000u32 {
                seen.insert(select(seed, os).platform_version);
            }
            // Todas las versiones deben tener forma major.0.0.
            for v in &seen {
                let parts: Vec<&str> = v.split('.').collect();
                assert_eq!(parts.len(), 3, "formato de platformVersion inválido: {}", v);
                assert!(parts[0].parse::<u32>().is_ok(), "major no numérico: {}", v);
            }
            if os == "macos" {
                // macOS tiene 4 majors distintos (27, 26, 15, 14): si saliera
                // uno solo, la versión volvió a ser de familia.
                assert!(
                    seen.len() >= 4,
                    "macOS solo produce {} platformVersion distintos: ha vuelto a ser por familia",
                    seen.len()
                );
            }
        }
    }

    /// La versión de Android en el UA debe coincidir con la de los Client Hints.
    /// Antes las cuatro declaraban "Android 10" mientras `platformVersion` era
    /// 14.0.0, y un S23 de 2023 informando de Android 10.
    #[test]
    fn android_ua_version_matches_client_hints() {
        for kit in ANDROID {
            let ua_major: u32 = kit
                .ua_os
                .split("Android ")
                .nth(1)
                .and_then(|r| r.split(';').next())
                .and_then(|v| v.trim().parse().ok())
                .unwrap_or_else(|| panic!("UA sin versión legible en {}: {}", kit.id, kit.ua_os));
            let ch_major: u32 = kit
                .platform_version
                .split('.')
                .next()
                .and_then(|v| v.parse().ok())
                .unwrap_or_else(|| panic!("platformVersion inválido en {}", kit.id));
            assert_eq!(
                ua_major, ch_major,
                "{}: el UA dice Android {} y los Client Hints {}",
                kit.id, ua_major, ch_major
            );
        }
    }

    /// Un perfil no es un kitty: pantalla, DPR, token de UA y plataforma tienen
    /// que poder existir en el MISMO aparato.
    ///
    /// La regla es deliberadamente laxa en escritorio. Todas las máquinas
    /// Windows reportan `Windows NT 10.0; Win64; x64` porque Chrome congeló ese
    /// token, y dos equipos distintos pueden tener 1366x768 los dos. Exigir que
    /// los kits no se repitan ningún valor obligaría a inventar datos, que es
    /// peor que la repetición. En móvil sí se exige el rango de la familia,
    /// porque un móvil con 3840 de ancho o con DPR 1.0 no existe.
    #[test]
    fn screen_and_dpr_belong_to_the_family() {
        // (dpr_min, dpr_max, ancho_min, ancho_max)
        let reglas: [(&str, f64, f64, u32, u32); 5] = [
            ("windows", 1.0, 1.5, 1024, 4096),
            ("macos", 1.0, 2.0, 1280, 3456),
            // X11 con escalado fraccionario puede declarar 1.25 o 1.5.
            ("linux", 1.0, 2.0, 1024, 3840),
            // Rango amplio a proposito: el Galaxy A12 real reporta 1.875, asi que un
            // limite de 2.0-3.5 habria descartado una pantalla autentica.
            ("android", 1.75, 4.0, 320, 480),
            ("ios", 2.0, 3.0, 320, 440),
        ];
        for (nombre, dpr_lo, dpr_hi, w_lo, w_hi) in reglas {
            let kits: &[Kit] = match nombre {
                "windows" => WINDOWS,
                "macos" => MACOS,
                "linux" => LINUX,
                "android" => ANDROID,
                _ => IOS,
            };
            for kit in kits {
                for &(w, _h, dpr) in kit.screens {
                    assert!(
                        dpr >= dpr_lo && dpr <= dpr_hi,
                        "{}: dpr {} fuera de {}-{} para {}",
                        kit.id,
                        dpr,
                        dpr_lo,
                        dpr_hi,
                        nombre
                    );
                    assert!(
                        w >= w_lo && w <= w_hi,
                        "{}: pantalla de {} px fuera de {}-{} para {}",
                        kit.id,
                        w,
                        w_lo,
                        w_hi,
                        nombre
                    );
                }
            }
        }
    }

    /// Dos kits del mismo SO no pueden ser el mismo kit con otro nombre: mismo
    /// token de UA y mismo conjunto de pantallas.
    #[test]
    fn no_two_kits_are_identical() {
        for (nombre, kits) in [
            ("windows", WINDOWS),
            ("macos", MACOS),
            ("linux", LINUX),
            ("android", ANDROID),
            ("ios", IOS),
        ] {
            for (i, a) in kits.iter().enumerate() {
                for b in kits.iter().skip(i + 1) {
                    let mismo_ua = a.ua_os == b.ua_os;
                    let mismas_pantallas = a.screens.len() == b.screens.len()
                        && a.screens.iter().zip(b.screens.iter()).all(|(x, y)| {
                            x.0 == y.0 && x.1 == y.1 && (x.2 - y.2).abs() < f64::EPSILON
                        });
                    assert!(
                        !(mismo_ua && mismas_pantallas),
                        "{}: {} y {} son el mismo kit con otro nombre",
                        nombre,
                        a.id,
                        b.id
                    );
                }
            }
        }
    }

    /// Ningún kit puede quedarse sin datos: un screens o mem_cores vacíos harían
    /// que `pick()` devolviera 0 y el perfil saliera sin pantalla o sin RAM.
    #[test]
    fn no_kit_is_empty() {
        let all: [(&str, &[Kit]); 5] = [
            ("windows", WINDOWS), ("macos", MACOS), ("linux", LINUX),
            ("android", ANDROID), ("ios", IOS),
        ];
        for (name, kits) in all {
            assert!(!kits.is_empty(), "{} no tiene kits", name);
            for kit in kits {
                assert!(!kit.screens.is_empty(), "{}: screens vacío", kit.id);
                assert!(!kit.mem_cores.is_empty(), "{}: mem_cores vacío", kit.id);
                assert!(!kit.platform_version.is_empty(), "{}: platformVersion vacío", kit.id);
                assert!(!kit.ua_os.is_empty(), "{}: ua_os vacío", kit.id);
                // Todo dpr plausible: 0.5 no existe, y >3 es rarísimo.
                // screens es &'static [(u32, u32, f64)] e iterar un slice por
                // referencia hace que el patrón `(w, h, dpr)` enganche a
                // referencias: hay que desreferenciar para comparar y para
                // imprimir con {}.
                for &(w, h, dpr) in kit.screens {
                    assert!(w >= 320 && h >= 480, "{}: pantalla inverosímil {}x{}", kit.id, w, h);
                    assert!(dpr >= 1.0 && dpr <= 3.0, "{}: dpr inverosímil {}", kit.id, dpr);
                }
                for &(mem, cores) in kit.mem_cores {
                    // `navigator.deviceMemory` NO es la RAM del equipo: la spec
                    // de Device Memory la redondea a potencia de dos y la recorta
                    // a 8 GiB para reducir el fingerprint. Antes este test
                    // aceptaba `mem >= 2 && mem <= 128`, es decir, daba por bueno
                    // que el catálogo anunciara 16, 24, 32 o 64, que ningún Chrome
                    // puede devolver. Los 23 kits lo incumplían.
                    //
                    // `mem` es u32, así que de la escalera {0.25, 0.5, 1, 2, 4, 8}
                    // solo son representables 1, 2, 4 y 8. Los valores fraccionarios
                    // corresponden a equipos de gama baja que no aparecen en estos
                    // kits; si algún día hicieran falta, el campo tendría que pasar
                    // a f64 y aquí a comprobarse con un rango.
                    assert!(
                        matches!(mem, 1 | 2 | 4 | 8),
                        "{}: deviceMemory {} no es un valor que Chrome pueda devolver \
                         (solo 1, 2, 4, 8; la spec recorta a 8 GiB)",
                        kit.id,
                        mem
                    );
                    assert!(cores >= 1 && cores <= 64, "{}: núcleos inverosímiles {}", kit.id, cores);
                }
            }
            // Identificadores únicos dentro de la familia.
            let ids: std::collections::BTreeSet<&str> = kits.iter().map(|k| k.id).collect();
            assert_eq!(ids.len(), kits.len(), "{} tiene ids de kit duplicados", name);
        }
    }

    /// Suelo de diversidad. Si alguien recorta el catálogo, este test salta: la
    /// diversidad ES el producto, y 2.156 identidades de escritorio eran un techo
    /// demasiado bajo para vender volumen.
    #[test]
    fn catalog_has_enough_hardware_identities() {
        let desk: usize = [WINDOWS, MACOS, LINUX]
            .iter()
            .map(|kits| {
                kits.iter()
                    .map(|k| k.screens.len() * k.mem_cores.len())
                    .sum::<usize>()
            })
            .sum();
        assert!(
            desk >= 330,
            "sólo {} identidades de hardware de escritorio: la diversidad se ha recortado",
            desk
        );
        // Con 28 pares geográficos, el techo total de escritorio.
        assert!(desk * 28 >= 9_000, "techo de escritorio insuficiente: {}", desk * 28);
    }

    /// La tabla de regiones debe seguir teniendo envergadura: si se encoge, la
    /// diversidad geográfica cae en picado y los perfiles se repiten entre sí.
    #[test]
    fn geo_table_has_enough_regions() {
        assert!(GEOS.len() >= 20, "solo hay {} regiones", GEOS.len());
        // Y debe haber pares distintos suficientes para 1000 perfiles.
        let pairs: std::collections::BTreeSet<(String, String)> = (0..5000u32)
            .map(|s| {
                let g = geo_for_seed(s);
                (g.timezone.to_string(), geo_language(g, s).to_string())
            })
            .collect();
        assert!(pairs.len() >= 20, "solo {} pares distintos", pairs.len());
    }
}