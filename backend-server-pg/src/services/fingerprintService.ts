// Servicio de identidad de huella — paridad EXACTA con el catálogo Rust.
// Fuentes: client/src-tauri/src/pools.rs (select), cdp.rs (fnv1a32),
// backend.rs (auto_os, FNV-1a 64). La receta vive en el servidor: el cliente
// solo recibe el resultado ya derivado de su profile_id.
//
// Este fichero es la FUENTE DE VERDAD del catálogo: añadir un kit es cambiar el
// array de aquí y reiniciar, sin recompilar el cliente. pools.rs queda como
// respaldo para cuando el backend no responde, y por eso pueden divergir sin
// que nada rompa: mientras el servidor responda, manda esta lista.
//
// Lo que el cliente elige es el SISTEMA OPERATIVO (resolveOs). Antes el SO se
// sorteaba con autoOs(), 60/25/15 entre windows/macos/linux, así que un usuario
// en Linux podía recibir `macos` y obtener un perfil que se anuncia como Mac
// sobre un motor Linux: una contradicción que delata la emulación en la primera
// petición, porque la firma TLS y el HTTP/2 no se falsifican desde JS.

export interface FingerprintIdentityDto {
  kitId: string;
  fullVersion: string;
  major: number;
  platform: string;
  uaOs: string;
  platformVersion: string;
  screenWidth: number;
  screenHeight: number;
  devicePixelRatio: number;
  deviceMemory: number;
  cores: number;
  timezone: string;
  language: string;
}

export type OsKey = 'windows' | 'macos' | 'linux' | 'android' | 'ios';

export interface FingerprintResponse {
  profileId: string;
  seed: number;
  os: OsKey;
  identity: FingerprintIdentityDto;
}

/**
 * Major de Chrome que puede anunciar el backend.
 *
 * Debe ser EXACTAMENTE el del motor que ejecuta el cliente (`DEFAULT_MAJOR` de
 * pools.rs). Antes se sorteaba entre 152, 153 y 154, así que un backend podía
 * devolver una UA 152 sobre un binario 154: la incoherencia se ve en la firma
 * TLS y en HTTP/2, que no se falsifican desde JS. Tampoco puede ir rezagado:
 * al subir el motor a 156, el catálogo quedó en 154 y el validador de CI lo
 * cazó de inmediato.
 *
 * La diversidad tiene que salir del kit, pantalla, memoria y región; nunca de
 * la versión. `tools/fingerprint-lab/validate.mjs` comprueba en CI que el
 * major de pools.rs esté en esta lista.
 */
const PARTIALS = [156];

interface Kit {
  id: string;
  uaOs: string;
  /**
   * Versión de plataforma para `navigator.userAgentData`. Es POR KIT, no por
   * familia, y DEBE coincidir con la versión de SO que aparece en `uaOs`.
   *
   * Antes vivía en osFamily(), o sea una constante por familia, mientras la UA
   * sí era por kit. Resultado: los cuatro kits Android anunciaban `Android 10`
   * en la UA y `12.0.0` en Client Hints, en la misma respuesta. También el
   * iPhone 14 decía iOS 16 y 17.4 a la vez.
   *
   * Es la misma razón por la que pools.rs lo tenía por kit desde el principio.
   */
  platformVersion: string;
  screens: [number, number, number][];
  memCores: [number, number][];
}

const WINDOWS: Kit[] = [
  { id: 'win11-25h2-gaming', uaOs: 'Windows NT 10.0; Win64; x64', platformVersion: '15.0.0', screens: [[1920, 1080, 1], [2560, 1440, 1], [1920, 1080, 1.25], [3840, 2160, 1.5], [2560, 1440, 1.25]], memCores: [[8, 8], [8, 16], [4, 16], [8, 12], [8, 24]] },
  { id: 'win11-25h2-laptop', uaOs: 'Windows NT 10.0; Win64; x64', platformVersion: '15.0.0', screens: [[1920, 1080, 1], [1536, 864, 1.25], [1920, 1200, 1], [1680, 1050, 1]], memCores: [[8, 8], [8, 12], [4, 16], [8, 16]] },
  { id: 'win11-24h2-office', uaOs: 'Windows NT 10.0; Win64; x64', platformVersion: '15.0.0', screens: [[1920, 1080, 1], [2560, 1440, 1], [1440, 900, 1], [1536, 864, 1], [1920, 1200, 1]], memCores: [[8, 4], [8, 8], [4, 8], [4, 4], [8, 6]] },
  { id: 'win11-24h2-hd', uaOs: 'Windows NT 10.0; Win64; x64', platformVersion: '15.0.0', screens: [[1366, 768, 1], [1280, 720, 1], [1600, 900, 1]], memCores: [[4, 4], [4, 8], [8, 8], [2, 2]] },
  { id: 'win11-23h2', uaOs: 'Windows NT 10.0; Win64; x64', platformVersion: '15.0.0', screens: [[1920, 1080, 1], [1366, 768, 1], [1280, 720, 1], [1600, 900, 1], [1536, 864, 1]], memCores: [[4, 4], [8, 8], [8, 12], [8, 16], [4, 8]] },
  { id: 'win11-26h1', uaOs: 'Windows NT 10.0; Win64; x64', platformVersion: '15.0.0', screens: [[2560, 1600, 1], [1920, 1080, 1], [2880, 1800, 1], [2240, 1400, 1], [3456, 2234, 1]], memCores: [[8, 12], [8, 16], [8, 20], [8, 24], [4, 16]] },
  { id: 'win10-22h2', uaOs: 'Windows NT 10.0; Win64; x64', platformVersion: '15.0.0', screens: [[1920, 1080, 1], [1366, 768, 1], [1280, 720, 1], [1536, 864, 1]], memCores: [[4, 4], [4, 8], [8, 8], [8, 16]] },
  { id: 'win10-22h2-office', uaOs: 'Windows NT 10.0; Win64; x64', platformVersion: '15.0.0', screens: [[1440, 900, 1], [1600, 900, 1], [1280, 1024, 1], [1680, 1050, 1]], memCores: [[8, 4], [8, 8], [4, 4], [4, 2]] },
  { id: 'win-server-2022', uaOs: 'Windows NT 10.0; Win64; x64', platformVersion: '10.0.0', screens: [[1024, 768, 1], [1920, 1080, 1], [1280, 1024, 1], [1440, 900, 1]], memCores: [[8, 8], [8, 4], [8, 16], [4, 4]] },
];

const MACOS: Kit[] = [
  { id: 'mac26-tahoe', uaOs: 'Macintosh; Intel Mac OS X 10_15_7', platformVersion: '26.0.0', screens: [[3024, 1964, 2], [2560, 1440, 2], [1728, 1117, 2], [1920, 1080, 2], [1512, 982, 2]], memCores: [[8, 10], [8, 12], [4, 12], [8, 16], [8, 8]] },
  { id: 'mac26-tahoe-m3pro', uaOs: 'Macintosh; Intel Mac OS X 10_15_7', platformVersion: '26.0.0', screens: [[3024, 1964, 2], [1512, 982, 2], [1728, 1117, 2], [2056, 1329, 2]], memCores: [[8, 12], [8, 14], [8, 16], [8, 20]] },
  { id: 'mac15-sequoia', uaOs: 'Macintosh; Intel Mac OS X 10_15_7', platformVersion: '15.0.0', screens: [[1920, 1080, 2], [2560, 1440, 2], [3024, 1964, 2], [1440, 900, 2], [1680, 1050, 2]], memCores: [[8, 8], [4, 8], [8, 10], [8, 12], [4, 10]] },
  { id: 'mac15-sequoia-m2', uaOs: 'Macintosh; Intel Mac OS X 10_15_7', platformVersion: '15.0.0', screens: [[1470, 956, 2], [1512, 982, 2], [1728, 1117, 2], [1440, 900, 2]], memCores: [[8, 8], [8, 10], [4, 8], [8, 12]] },
  { id: 'mac14-sonoma', uaOs: 'Macintosh; Intel Mac OS X 10_15_7', platformVersion: '14.0.0', screens: [[1440, 900, 2], [2560, 1440, 2], [1280, 800, 2], [1680, 1050, 2]], memCores: [[8, 8], [4, 8], [8, 10], [4, 10]] },
  { id: 'mac13-ventura', uaOs: 'Macintosh; Intel Mac OS X 10_15_7', platformVersion: '13.0.0', screens: [[2560, 1440, 2], [1920, 1080, 2], [1680, 1050, 2], [1440, 900, 2], [1280, 800, 2]], memCores: [[8, 8], [8, 10], [4, 8], [4, 6], [8, 12]] },
  // El M2 Air tiene siempre 8 nucleos y 8 o 16 GB de memoria unificada, y las
  // dos announce 8. Una tercera combinacion seria inventarla.
  { id: 'macbook-air-m2', uaOs: 'Macintosh; Intel Mac OS X 10_15_7', platformVersion: '14.0.0', screens: [[1440, 900, 2], [1680, 1050, 2], [1470, 956, 2]], memCores: [[8, 8], [4, 8]] },
  // Monitor externo sin Retina: devicePixelRatio 1.0 es real en macOS, no un
  // error. Por eso el rango de macOS no puede ser solo 2.0.
  { id: 'mac-external-1x', uaOs: 'Macintosh; Intel Mac OS X 10_15_7', platformVersion: '15.0.0', screens: [[1920, 1080, 1], [2560, 1440, 1], [1600, 900, 1], [1280, 720, 1]], memCores: [[8, 8], [8, 10], [4, 8], [8, 12]] },
];

/**
 * Linux era la familia más pobre del catálogo: dos kits y 1.980 identidades
 * distintas frente a 6.682 de Windows. No era por el DPR (en Linux es 1.0 y
 * punto) sino porque no había más donde elegir.
 *
 * Cada kit lleva la versión de kernel de su distribución en platformVersion,
 * porque Client Hints la lee y una distro diciendo la versión de otra también se
 * delata.
 */
const LINUX: Kit[] = [
  { id: 'ubuntu-24.04', uaOs: 'X11; Linux x86_64', platformVersion: '6.8.0', screens: [[1920, 1080, 1], [1366, 768, 1], [1280, 1024, 1], [2560, 1440, 1], [1600, 900, 1]], memCores: [[4, 4], [8, 8], [4, 8], [8, 16], [4, 16]] },
  { id: 'ubuntu-22.04', uaOs: 'X11; Linux x86_64', platformVersion: '5.15.0', screens: [[1920, 1080, 1], [1366, 768, 1], [1440, 900, 1], [1536, 864, 1]], memCores: [[4, 4], [8, 8], [8, 6], [4, 8]] },
  { id: 'ubuntu-server-24.04', uaOs: 'X11; Linux x86_64', platformVersion: '6.8.0', screens: [[1024, 768, 1], [1280, 1024, 1], [1440, 900, 1], [1680, 1050, 1]], memCores: [[8, 4], [8, 8], [8, 2], [4, 4]] },
  { id: 'fedora-42', uaOs: 'X11; Linux x86_64', platformVersion: '6.11.0', screens: [[1920, 1080, 1], [2560, 1440, 1], [1920, 1200, 1], [1680, 1050, 1]], memCores: [[8, 8], [8, 12], [8, 16], [8, 6]] },
  { id: 'fedora-workstation-42', uaOs: 'X11; Linux x86_64', platformVersion: '6.11.0', screens: [[2560, 1440, 1], [3840, 2160, 1.5], [1920, 1080, 1], [2560, 1600, 1]], memCores: [[8, 16], [8, 32], [8, 24], [4, 16]] },
  { id: 'debian-12', uaOs: 'X11; Linux x86_64', platformVersion: '6.1.0', screens: [[1920, 1080, 1], [1366, 768, 1], [1280, 1024, 1], [1920, 1200, 1]], memCores: [[4, 2], [8, 4], [8, 8], [4, 8]] },
  { id: 'arch-linux', uaOs: 'X11; Linux x86_64', platformVersion: '6.9.0', screens: [[2560, 1440, 1], [1920, 1080, 1], [3440, 1440, 1], [3840, 2160, 1.5]], memCores: [[8, 12], [8, 16], [8, 24], [8, 32]] },
  { id: 'linux-mint-22', uaOs: 'X11; Linux x86_64', platformVersion: '6.8.0', screens: [[1920, 1080, 1], [1366, 768, 1], [1600, 900, 1], [1280, 1024, 1]], memCores: [[4, 4], [8, 8], [4, 8], [8, 6]] },
  { id: 'pop-os-24', uaOs: 'X11; Linux x86_64', platformVersion: '6.8.0', screens: [[1920, 1080, 1], [2560, 1440, 1], [1366, 768, 1], [1536, 864, 1]], memCores: [[8, 8], [8, 12], [8, 16], [4, 8]] },
  { id: 'opensuse-tumbleweed', uaOs: 'X11; Linux x86_64', platformVersion: '6.4.0', screens: [[1920, 1080, 1], [1600, 900, 1], [1280, 1024, 1], [1680, 1050, 1]], memCores: [[8, 8], [8, 12], [4, 4], [8, 16]] },
  { id: 'gentoo', uaOs: 'X11; Linux x86_64', platformVersion: '6.6.0', screens: [[1920, 1080, 1], [2560, 1440, 1], [3440, 1440, 1], [1600, 900, 1]], memCores: [[8, 16], [8, 24], [8, 32], [4, 8]] },
  { id: 'linux-hidpi-laptop', uaOs: 'X11; Linux x86_64', platformVersion: '6.8.0', screens: [[2560, 1440, 1.25], [1920, 1080, 1.25], [1680, 1050, 1.5], [2880, 1800, 1.5]], memCores: [[8, 8], [8, 12], [8, 16], [4, 8]] },
  { id: 'linux-generic', uaOs: 'X11; Linux x86_64', platformVersion: '6.6.0', screens: [[1440, 900, 1], [1920, 1080, 1], [1600, 900, 1], [1366, 768, 1]], memCores: [[4, 4], [8, 8], [2, 2], [8, 4]] },
];

// ─────────────────────────────────────────────────────────────────────────────
// ANDROID: POR VERSIÓN Y GAMA, NO POR MODELO
//
// El intento anterior listaba cinco teléfonos concretos (Galaxy A12, A15, S23,
// Pixel 8, Xiaomi 13). Eso está mal por partida doble: hay miles de Android y
// cinco modelos no cubren nada.
//
// POR QUÉ FUNCIONA CON 6 KITS Y NO CON 2000 MODELOS
//
// Chrome en Android manda la UA REDUCIDA, sin el modelo:
//
//   Mozilla/5.0 (Linux; Android 10; K) ... Chrome/151.0.0.0 Mobile Safari/537.36
//                          ^^^^^^^^^^^^  el "; K" es una constante de Chrome
//
// El modelo del teléfono NO aparece en ninguna señal. Lo único que cambia de un
// móvil a otro, aparte de la versión de Android, es pantalla, devicePixelRatio,
// deviceMemory, hardwareConcurrency y la GPU. Y los cuatro primeros los elige el
// seed DENTRO de lo posible en esa versión. Un kit por versión cubre así todos
// los Android de esa versión, no un modelo.
//
// LO QUE SE MIDÓ Y LO QUE SIGUE SIN MEDIRSE
//
// Del Samsung Galaxy A12 real (SM-A125U, Chrome 151) salieron datos que
// corrigieron suposiciones previas:
//
//   navigator.platform   Linux armv81      (un UNO, no la letra l: armv8l)
//   screen               385x854 @ 1.875   (720x1600 físicos)
//   deviceMemory         2
//   cores                8
//   maxTouchPoints       5
//   plugins              0, sin PDF Viewer
//   availWidth/Height    iguales a screen: en móvil no hay barra que descontar
//   GPU                  PowerVR Rogue GE8320
//
// El DPR 1.875 me corrigió a mí: antes escribí que "no es un DPR que Android
// pueda reportar" y lo cambié por 2.0. Era falso.
//
// LIMITACIONES, DICHAZAS
//
// - platformVersion de Android NO se ha podido leer: el laboratorio lo pedía por
//   la vía equivocada, porque los valores de alta entropía de Client Hints
//   necesitan getHighEntropyValues(). Ya está arreglado, pero falta volver a
//   medirlo en un móvil. Aquí es coherente con la UA por construcción, no por
//   medición.
//
// - La GPU no vive aquí: la decide el cliente, y hoy su tabla no tiene filas de
//   Android. Es el siguiente hueco.
//
// - Un perfil Android NO puede afirmar "soy un Galaxy S23". Puede afirmar "soy un
//   Android 14 con esta pantalla y esta GPU". Como el modelo no viaja en la UA,
//   tampoco viajaría en ninguna identidad verosímil.
// ─────────────────────────────────────────────────────────────────────────────
const ANDROID: Kit[] = [
  // Android 10-11 (2019-2021). Gamina de entrada: 720x1600 a dpr 1.875-2.0 y
  // poca memoria. El A12 medido cae aquí: 384x853 a 1.875 con 2 GB.
  { id: 'android-10-11', uaOs: 'Linux; Android 10; K', platformVersion: '10.0.0', screens: [[384, 853, 1.875], [360, 800, 2.0], [360, 740, 2.0]], memCores: [[2, 8], [2, 4]] },
  { id: 'android-11', uaOs: 'Linux; Android 11; K', platformVersion: '11.0.0', screens: [[393, 851, 2.75], [412, 915, 2.625], [360, 800, 3.0]], memCores: [[4, 8], [8, 8]] },

  // Android 12-13 (2021-2023). Gamina media con 1080x2400 y 4 GB de sobra.
  { id: 'android-12-13', uaOs: 'Linux; Android 12; K', platformVersion: '12.0.0', screens: [[412, 915, 2.625], [393, 851, 2.75], [384, 854, 2.8125]], memCores: [[4, 8], [8, 8]] },
  { id: 'android-13', uaOs: 'Linux; Android 13; K', platformVersion: '13.0.0', screens: [[412, 892, 3.0], [428, 926, 2.0], [360, 800, 3.0]], memCores: [[8, 8], [4, 12]] },

  // Android 14 (2023-2024).
  { id: 'android-14', uaOs: 'Linux; Android 14; K', platformVersion: '14.0.0', screens: [[412, 915, 2.625], [434, 894, 3.0], [360, 800, 3.5]], memCores: [[8, 8], [4, 8]] },

  // Android 15-16 (2024-2026). GAMMA ALTA: hasta 1440p a dpr 3.5 y 8 GB. Un
  // Android de esta gama casi nunca anuncia 2 GB, así que no se ofrece.
  { id: 'android-15-16', uaOs: 'Linux; Android 15; K', platformVersion: '15.0.0', screens: [[411, 891, 3.5], [412, 892, 3.0], [384, 854, 3.5]], memCores: [[8, 12], [8, 8]] },
];

// iOS va con dos componentes porque Chrome no existe en iOS: el valor no lo
// declara ningún navegador real, es la versión del SO tal cual la escribe el
// User-Agent. Ponerle un tercer componente sería inventar un dato.
// iOS NO está medido. No se ha podido ejecutar el laboratorio sobre un iPhone:
// Safari no implementa `navigator.userAgentData`, así que ni siquiera es
// comparable. Estos valores vienen de las especificaciones públicas de Apple y de
// lo que documentan los detectors, NO de una medición, y están marcados como
// tales a propósito. Si alguien tiene un iPhone, medirlos es el primer trabajo.
//
// Limitación que sí se sabe sin medir: `navigator.platform` en iPhone es
// 'iPhone', pero `navigator.plugins.length` es 0 (igual que en Android) y no hay
// PDF Viewer. Un perfil iOS o Android que se haga pasar por escritorio se
// delata ahí igual que en Android.
const IOS: Kit[] = [
  { id: 'ios-iphone-15-pro', uaOs: 'iPhone; CPU iPhone OS 17_4 like Mac OS X', platformVersion: '17.4', screens: [[430, 932, 3.0], [393, 852, 3.0]], memCores: [[8, 6]] },
  { id: 'ios-iphone-14', uaOs: 'iPhone; CPU iPhone OS 16_6 like Mac OS X', platformVersion: '16.6', screens: [[390, 844, 3.0]], memCores: [[4, 6]] },
];

/**
 * Región geográfica: timezone e idioma son una sola unidad.
 *
 * Antes el backend elegía `TIMEZONES[pick(seed, 6)]` y
 * `LANGS[pick(seed, 7)]` por separado, con 22 × 20 combinaciones de las que
 * solo una minoría era plausible. Eso producía `Asia/Tokyo + es-AR` o
 * `America/Santiago + ko-KR`: la comprobación más barata que hace un detector.
 *
 * Esta tabla es la misma que `GEOS` de pools.rs. `languages[0]` es el idioma
 * principal de la región; el resto son minorías plausibles y se eligen con
 * mucha menos frecuencia.
 */
export interface Geo {
  id: string;
  timezone: string;
  languages: readonly string[];
}

export const GEOS: readonly Geo[] = [
  { id: 'us-east', timezone: 'America/New_York', languages: ['en-US'] },
  { id: 'us-central', timezone: 'America/Chicago', languages: ['en-US'] },
  { id: 'us-mountain', timezone: 'America/Denver', languages: ['en-US'] },
  { id: 'us-west', timezone: 'America/Los_Angeles', languages: ['en-US'] },
  { id: 'mx', timezone: 'America/Mexico_City', languages: ['es-MX'] },
  { id: 'co', timezone: 'America/Bogota', languages: ['es-CO'] },
  { id: 'pe', timezone: 'America/Lima', languages: ['es-PE'] },
  { id: 'cl', timezone: 'America/Santiago', languages: ['es-CL'] },
  { id: 'ar', timezone: 'America/Argentina/Buenos_Aires', languages: ['es-AR'] },
  { id: 've', timezone: 'America/Caracas', languages: ['es-VE'] },
  { id: 'br', timezone: 'America/Sao_Paulo', languages: ['pt-BR'] },
  { id: 'es', timezone: 'Europe/Madrid', languages: ['es-ES', 'ca-ES'] },
  { id: 'fr', timezone: 'Europe/Paris', languages: ['fr-FR'] },
  { id: 'gb', timezone: 'Europe/London', languages: ['en-GB'] },
  { id: 'de', timezone: 'Europe/Berlin', languages: ['de-DE'] },
  { id: 'nl', timezone: 'Europe/Amsterdam', languages: ['nl-NL'] },
  { id: 'it', timezone: 'Europe/Rome', languages: ['it-IT'] },
  { id: 'pl', timezone: 'Europe/Warsaw', languages: ['pl-PL'] },
  { id: 'jp', timezone: 'Asia/Tokyo', languages: ['ja-JP'] },
  { id: 'kr', timezone: 'Asia/Seoul', languages: ['ko-KR'] },
  { id: 'cn', timezone: 'Asia/Shanghai', languages: ['zh-CN'] },
  { id: 'sg', timezone: 'Asia/Singapore', languages: ['en-SG', 'zh-CN', 'ms-SG', 'ta-SG'] },
  { id: 'au', timezone: 'Australia/Sydney', languages: ['en-AU'] },
  { id: 'nz', timezone: 'Pacific/Auckland', languages: ['en-NZ'] },
];

/**
 * Familia del SO: qué kits ofrece y qué token de `navigator.platform` usa.
 *
 * `platformVersion` NO sale de aquí: es por kit (campo `Kit.platformVersion`),
 * porque tiene que coincidir con la versión de SO que dice el token de la UA.
 * Antes vivía en esta función, como una constante por familia, y por eso los
 * cuatro kits Android declaraban `Android 10` en la UA y `12.0.0` en Client
 * Hints dentro de la misma respuesta.
 */
function osFamily(osKey: OsKey): { kits: Kit[]; platform: string } {
  switch (osKey) {
    case 'windows':
      return { kits: WINDOWS, platform: 'Win32' };
    case 'macos':
      return { kits: MACOS, platform: 'MacIntel' };
    case 'android':
      return { kits: ANDROID, platform: 'Linux armv81' };
    case 'ios':
      return { kits: IOS, platform: 'iPhone' };
    default:
      return { kits: LINUX, platform: 'Linux x86_64' };
  }
}

/** Finalizador de murmur3, igual que `fmix32` de pools.rs. */
function fmix32(x: number): number {
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}

/**
 * Mismo `pick` que pools.rs: `fmix32(h ^ i*0x9E3779B1)` y reducción
 * multiplicación-shift (Lemire). Antes el backend usaba módulo sobre el bit
 * bajo, no era paridad real con Rust y perdía diversidad.
 */
function pick(h: number, i: number, n: number): number {
  if (n <= 1) return 0;
  const mixed = fmix32((h ^ Math.imul(i, 0x9e3779b1)) >>> 0);
  return Math.floor((mixed * n) / 0x100000000);
}

/** Región por seed, igual que `geo_for_seed` de pools.rs. */
export function geoForSeed(seed: number): Geo {
  return GEOS[pick(seed, 6, GEOS.length)];
}

/** Idioma de la región: el principal gana ~88%; el resto son minorías. */
function geoLanguage(geo: Geo, seed: number): string {
  if (geo.languages.length === 1) return geo.languages[0];
  const roll = pick(seed, 7, 100);
  if (roll < 88) return geo.languages[0];
  return geo.languages[1 + ((roll - 88) % (geo.languages.length - 1))];
}

/** Paridad con pools::select(seed, os_key). el seed DEBE ir como u32. */
export function select(seed: number, osKey: OsKey): FingerprintIdentityDto {
  const { kits, platform } = osFamily(osKey);
  const kit = kits[pick(seed, 1, kits.length)];
  const platformVersion = kit.platformVersion;
  const major = PARTIALS[pick(seed, 2, PARTIALS.length)];
  const [sw, sh, dpr] = kit.screens[pick(seed, 3, kit.screens.length)];
  const [mem, cores] = kit.memCores[pick(seed, 5, kit.memCores.length)];

  // Timezone e idioma salen de la MISMA región, nunca de listas separadas.
  const geo = geoForSeed(seed);
  const timezone = geo.timezone;
  const language = geoLanguage(geo, seed);

  const patch = pick(Math.imul(seed, 2654435761), 8, 99) + 1;
  const build = pick(seed >>> 1, 9, 9);
  const fullVersion = `${major}.0.${build}.${patch}`;

  return {
    kitId: kit.id,
    fullVersion,
    major,
    platform,
    uaOs: kit.uaOs,
    platformVersion,
    screenWidth: sw,
    screenHeight: sh,
    devicePixelRatio: dpr,
    deviceMemory: mem,
    cores,
    timezone,
    language,
  };
}

/** Paridad con fnv1a de cdp.rs (32-bit) sobre el id. */
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Paridad con auto_os de backend.rs (FNV-1a 64 % 100). */
export function autoOs(id: string): OsKey {
  const p = 0x100000001b3n;
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < id.length; i++) {
    h ^= BigInt(id.charCodeAt(i));
    h = BigInt.asUintN(64, h * p);
  }
  const m = Number(h % 100n);
  if (m <= 59) return 'windows';
  if (m <= 84) return 'macos';
  return 'linux';
}

export const OS_KEYS: readonly OsKey[] = ['windows', 'macos', 'linux', 'android', 'ios'];

export function isOsKey(v: unknown): v is OsKey {
  return typeof v === 'string' && (OS_KEYS as readonly string[]).includes(v);
}

/**
 * De donde sale el SO, y por que. Se persiste igual elija lo que elija,
 * incluido el sorteo, para que un perfil no cambie de identidad entre sesiones.
 *
 * `autoOs` sortea 60/25/15 entre windows/macos/linux. Antes era la unica
 * fuente, y por eso un usuario en Linux recibia `macos`. El motor real es el
 * Chrome que ejecuta el cliente, y su firma TLS y su HTTP/2 no se pueden
 * falsificar desde JS: un perfil que se anuncia como Mac sobre un motor Linux
 * se contradice en la primera peticion. Por eso el SO lo dice el cliente, y el
 * sorteo queda solo como respaldo para los clientes antiguos que no lo mandan.
 *
 * - stored:      ya estaba fijado. Gana siempre; es lo que da estabilidad.
 * - requested:   lo dice el cliente en esta peticion.
 * - device:      como se registro la sesion (login), si el cliente no manda nada.
 * - auto:        sorteo por profile_id. Ultimo recurso.
 */
export function resolveOs(opts: {
  profileId: string;
  stored?: OsKey | null;
  requested?: unknown;
  device?: string | null;
}): { os: OsKey; source: 'stored' | 'requested' | 'device' | 'auto' } {
  if (isOsKey(opts.stored)) return { os: opts.stored, source: 'stored' };
  if (isOsKey(opts.requested)) return { os: opts.requested, source: 'requested' };
  const dev = (opts.device || '').toLowerCase();
  if (isOsKey(dev)) return { os: dev as OsKey, source: 'device' };
  return { os: autoOs(opts.profileId), source: 'auto' };
}

/** Receta completa para un profile_id: server-owned, estable de por vida. */
export function computeFingerprint(profileId: string, os?: OsKey): FingerprintResponse {
  const seed = fnv1a32(profileId);
  const chosen = isOsKey(os) ? os : autoOs(profileId);
  return { profileId, seed, os: chosen, identity: select(seed, chosen) };
}

/**
 * País (ISO 3166-1 alpha-2) -> pareja timezone/idioma.
 *
 * El país del egress (header CF-IPCountry de Cloudflare o hint del cliente)
 * sustituye la región del seed, pero SIEMPRE cambia los dos campos juntos. Antes
 * había dos mapas separados: un país podía aportar `Europe/Stockholm` y dejar
 * el idioma del seed (`es-ES`), que es justo la incoherencia que se quería
 * evitar. Países sin entrada conservan la región derivada del seed.
 */
export interface CountryGeo {
  timezone: string;
  language: string;
}

export const countryGeo = new Map<string, CountryGeo>([
  ['MX', { timezone: 'America/Mexico_City', language: 'es-MX' }],
  ['US', { timezone: 'America/New_York', language: 'en-US' }],
  ['CA', { timezone: 'America/Toronto', language: 'en-CA' }],
  ['AR', { timezone: 'America/Argentina/Buenos_Aires', language: 'es-AR' }],
  ['BR', { timezone: 'America/Sao_Paulo', language: 'pt-BR' }],
  ['CL', { timezone: 'America/Santiago', language: 'es-CL' }],
  ['CO', { timezone: 'America/Bogota', language: 'es-CO' }],
  ['PE', { timezone: 'America/Lima', language: 'es-PE' }],
  ['ES', { timezone: 'Europe/Madrid', language: 'es-ES' }],
  ['FR', { timezone: 'Europe/Paris', language: 'fr-FR' }],
  ['DE', { timezone: 'Europe/Berlin', language: 'de-DE' }],
  ['GB', { timezone: 'Europe/London', language: 'en-GB' }],
  ['IT', { timezone: 'Europe/Rome', language: 'it-IT' }],
  ['PT', { timezone: 'Europe/Lisbon', language: 'pt-PT' }],
  ['NL', { timezone: 'Europe/Amsterdam', language: 'nl-NL' }],
  ['SE', { timezone: 'Europe/Stockholm', language: 'sv-SE' }],
  ['NO', { timezone: 'Europe/Oslo', language: 'nb-NO' }],
  ['DK', { timezone: 'Europe/Copenhagen', language: 'da-DK' }],
  ['FI', { timezone: 'Europe/Helsinki', language: 'fi-FI' }],
  ['PL', { timezone: 'Europe/Warsaw', language: 'pl-PL' }],
  ['CZ', { timezone: 'Europe/Prague', language: 'cs-CZ' }],
  ['AT', { timezone: 'Europe/Vienna', language: 'de-AT' }],
  ['CH', { timezone: 'Europe/Zurich', language: 'de-CH' }],
  ['BE', { timezone: 'Europe/Brussels', language: 'nl-BE' }],
  ['IE', { timezone: 'Europe/Dublin', language: 'en-IE' }],
  ['RU', { timezone: 'Europe/Moscow', language: 'ru-RU' }],
  ['UA', { timezone: 'Europe/Kiev', language: 'uk-UA' }],
  ['TR', { timezone: 'Europe/Istanbul', language: 'tr-TR' }],
  ['GR', { timezone: 'Europe/Athens', language: 'el-GR' }],
  ['RO', { timezone: 'Europe/Bucharest', language: 'ro-RO' }],
  ['BG', { timezone: 'Europe/Sofia', language: 'bg-BG' }],
  ['HU', { timezone: 'Europe/Budapest', language: 'hu-HU' }],
  ['SK', { timezone: 'Europe/Bratislava', language: 'sk-SK' }],
  ['SI', { timezone: 'Europe/Ljubljana', language: 'sl-SI' }],
  ['HR', { timezone: 'Europe/Zagreb', language: 'hr-HR' }],
  ['RS', { timezone: 'Europe/Belgrade', language: 'sr-RS' }],
  ['TH', { timezone: 'Asia/Bangkok', language: 'th-TH' }],
  ['IN', { timezone: 'Asia/Kolkata', language: 'hi-IN' }],
  ['JP', { timezone: 'Asia/Tokyo', language: 'ja-JP' }],
  ['KR', { timezone: 'Asia/Seoul', language: 'ko-KR' }],
  ['CN', { timezone: 'Asia/Shanghai', language: 'zh-CN' }],
  ['HK', { timezone: 'Asia/Hong_Kong', language: 'zh-HK' }],
  ['TW', { timezone: 'Asia/Taipei', language: 'zh-TW' }],
  ['SG', { timezone: 'Asia/Singapore', language: 'en-SG' }],
  ['MY', { timezone: 'Asia/Kuala_Lumpur', language: 'ms-MY' }],
  ['ID', { timezone: 'Asia/Jakarta', language: 'id-ID' }],
  ['PH', { timezone: 'Asia/Manila', language: 'fil-PH' }],
  ['VN', { timezone: 'Asia/Ho_Chi_Minh', language: 'vi-VN' }],
  ['AE', { timezone: 'Asia/Dubai', language: 'ar-AE' }],
  ['SA', { timezone: 'Asia/Riyadh', language: 'ar-SA' }],
  ['IL', { timezone: 'Asia/Jerusalem', language: 'he-IL' }],
  ['PK', { timezone: 'Asia/Karachi', language: 'ur-PK' }],
  ['BD', { timezone: 'Asia/Dhaka', language: 'bn-BD' }],
  ['AU', { timezone: 'Australia/Sydney', language: 'en-AU' }],
  ['NZ', { timezone: 'Pacific/Auckland', language: 'en-NZ' }],
  ['ZA', { timezone: 'Africa/Johannesburg', language: 'en-ZA' }],
  ['EG', { timezone: 'Africa/Cairo', language: 'ar-EG' }],
  ['NG', { timezone: 'Africa/Lagos', language: 'en-NG' }],
  ['MA', { timezone: 'Africa/Casablanca', language: 'ar-MA' }],
  ['KE', { timezone: 'Africa/Nairobi', language: 'en-KE' }],
  ['DZ', { timezone: 'Africa/Algiers', language: 'ar-DZ' }],
  ['GT', { timezone: 'America/Guatemala', language: 'es-GT' }],
  ['SV', { timezone: 'America/El_Salvador', language: 'es-SV' }],
  ['CR', { timezone: 'America/Costa_Rica', language: 'es-CR' }],
  ['PA', { timezone: 'America/Panama', language: 'es-PA' }],
  ['CU', { timezone: 'America/Havana', language: 'es-CU' }],
  ['DO', { timezone: 'America/Santo_Domingo', language: 'es-DO' }],
  ['PR', { timezone: 'America/Puerto_Rico', language: 'es-PR' }],
  ['HT', { timezone: 'America/Port-au-Prince', language: 'fr-HT' }],
  ['JM', { timezone: 'America/Jamaica', language: 'en-JM' }],
  ['TT', { timezone: 'America/Port_of_Spain', language: 'en-TT' }],
  ['VE', { timezone: 'America/Caracas', language: 'es-VE' }],
  ['EC', { timezone: 'America/Guayaquil', language: 'es-EC' }],
  ['BO', { timezone: 'America/La_Paz', language: 'es-BO' }],
  ['UY', { timezone: 'America/Montevideo', language: 'es-UY' }],
  ['PY', { timezone: 'America/Asuncion', language: 'es-PY' }],
]);

/** Vistas derivadas para compatibilidad con código/tests anteriores. */
export const timezoneForCountry = new Map<string, string>(
  [...countryGeo].map(([cc, geo]) => [cc, geo.timezone] as const),
);

export const languageForCountry = new Map<string, string>(
  [...countryGeo].map(([cc, geo]) => [cc, geo.language] as const),
);