// Catálogo rotativo y generador de identidades coherentes por OS y Navegador.
// Cada kit combina surfaces que deben verse 100% coherentes entre sí:
//   UA major <-> platformVersion <-> Sec-CH-UA brands <-> screens <-> GPU <-> RAM/cores <-> TZ <-> idioma.
// Selección determinista por seed o aleatoria bajo demanda.

export const BROWSER_TYPES = {
  chrome: 'Google Chrome',
  edge: 'Microsoft Edge',
  opera: 'Opera',
  samsung: 'Samsung Internet',
  firefox: 'Mozilla Firefox',
  safari: 'Apple Safari',
};

export const KITS = {
  windows: [
    {
      id: 'win11-rtx4070',
      name: 'Windows 11 Pro 24H2 · RTX 4070 (Gamer/Power)',
      platform: 'Win32',
      uaOS: 'Windows NT 10.0; Win64; x64',
      platformVersion: '15.0.0',
      majorBase: 151,
      screens: [
        { w: 1920, h: 1080, dpr: 1, availH: 1040 },
        { w: 2560, h: 1440, dpr: 1, availH: 1400 },
        { w: 3840, h: 2160, dpr: 1.5, availH: 2100 },
      ],
      gpus: [
        'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)',
        'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
        'ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU Direct3D11 vs_5_0 ps_5_0, D3D11)',
      ],
      memCores: [
        { deviceMemory: 8, cores: 16 },
        { deviceMemory: 4, cores: 16 },
        { deviceMemory: 8, cores: 12 },
      ],
    },
    {
      id: 'win11-iris-xe',
      name: 'Windows 11 Home 23H2 · Intel Iris Xe (Laptop)',
      platform: 'Win32',
      uaOS: 'Windows NT 10.0; Win64; x64',
      platformVersion: '15.0.0',
      majorBase: 150,
      screens: [
        { w: 1920, h: 1080, dpr: 1.25, availH: 1032 },
        { w: 1536, h: 864, dpr: 1, availH: 824 },
        { w: 1440, h: 900, dpr: 1, availH: 860 },
      ],
      gpus: [
        'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x00009A49) Direct3D11 vs_5_0 ps_5_0, D3D11)',
        'ANGLE (Intel, Intel(R) Iris(R) Plus Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)',
        'ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)',
      ],
      memCores: [
        { deviceMemory: 8, cores: 8 },
        { deviceMemory: 4, cores: 8 },
      ],
    },
    {
      id: 'win10-office',
      name: 'Windows 10 Pro 22H2 · Intel UHD 630 (Estándar)',
      platform: 'Win32',
      uaOS: 'Windows NT 10.0; Win64; x64',
      platformVersion: '14.0.0',
      majorBase: 149,
      screens: [
        { w: 1366, h: 768, dpr: 1, availH: 728 },
        { w: 1920, h: 1080, dpr: 1, availH: 1040 },
        { w: 1280, h: 720, dpr: 1, availH: 680 },
      ],
      gpus: [
        'ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E92) Direct3D11 vs_5_0 ps_5_0, D3D11)',
        'ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00005917) Direct3D11 vs_5_0 ps_5_0, D3D11)',
        'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      ],
      memCores: [
        { deviceMemory: 8, cores: 4 },
        { deviceMemory: 8, cores: 8 },
        { deviceMemory: 4, cores: 4 },
      ],
    },
  ],

  macos: [
    {
      id: 'mac15-sequoia-m3',
      name: 'macOS 15 Sequoia · Apple M3 Max (Retina)',
      platform: 'MacIntel',
      uaOS: 'Macintosh; Intel Mac OS X 10_15_7',
      platformVersion: '0.0.0',
      majorBase: 151,
      screens: [
        { w: 1920, h: 1080, dpr: 2, availH: 1055 },
        { w: 2560, h: 1440, dpr: 2, availH: 1415 },
        { w: 3024, h: 1964, dpr: 2, availH: 1940 },
      ],
      gpus: [
        'Apple GPU',
        'ANGLE (Apple, Apple M3 Max Direct3D11 vs_5_0 ps_5_0)',
        'ANGLE (Apple, Apple M3 Pro, OpenGL 4.1)',
      ],
      memCores: [
        { deviceMemory: 8, cores: 12 },
        { deviceMemory: 8, cores: 14 },
        { deviceMemory: 4, cores: 14 },
      ],
    },
    {
      id: 'mac14-sonoma-m2',
      name: 'macOS 14 Sonoma · Apple M2 Pro (MacBook)',
      platform: 'MacIntel',
      uaOS: 'Macintosh; Intel Mac OS X 10_15_7',
      platformVersion: '0.0.0',
      majorBase: 149,
      screens: [
        { w: 1440, h: 900, dpr: 2, availH: 875 },
        { w: 1680, h: 1050, dpr: 2, availH: 1025 },
        { w: 1280, h: 800, dpr: 2, availH: 775 },
      ],
      gpus: [
        'Apple GPU',
        'ANGLE (Apple, Apple M2 Pro, OpenGL 4.1)',
        'ANGLE (Apple, Apple M2 Direct3D11 vs_5_0 ps_5_0)',
      ],
      memCores: [
        { deviceMemory: 8, cores: 8 },
        { deviceMemory: 8, cores: 10 },
      ],
    },
  ],

  linux: [
    {
      id: 'ubuntu-24-04',
      name: 'Ubuntu 24.04 LTS · Mesa Intel / RADV',
      platform: 'Linux x86_64',
      uaOS: 'X11; Linux x86_64',
      platformVersion: '6.0.0',
      majorBase: 151,
      screens: [
        { w: 1920, h: 1080, dpr: 1, availH: 1040 },
        { w: 2560, h: 1440, dpr: 1, availH: 1400 },
      ],
      gpus: [
        'ANGLE (Mesa, Vulkan 1.3.0 (Intel, Mesa (Intel(R) Xe Graphics)) )',
        'ANGLE (Mesa, Vulkan 1.3.0 (AMD, RADV RENOIR) )',
        'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060, OpenGL 4.6)',
      ],
      memCores: [
        { deviceMemory: 8, cores: 8 },
        { deviceMemory: 8, cores: 12 },
        { deviceMemory: 8, cores: 16 },
      ],
    },
  ],

  android: [
    {
      id: 'android-samsung-a12',
      name: 'Samsung Galaxy A12 (SM-A125U · Mali-G52)',
      platform: 'Linux armv8l',
      uaOS: 'Linux; Android 12; SM-A125U',
      reducedUA: 'Linux; Android 10; K',
      model: 'SM-A125U',
      brand: 'Samsung',
      platformVersion: '12.0.0',
      majorBase: 151,
      screens: [
        // El A12 real es 720x1600 a densidad 2.0, o sea 360x800 en CSS px. El
        // 384x766@1.875 que había antes no es un DPR que Android pueda
        // reportar: los buckets de densidad son 1.0, 1.5, 2.0, 2.5, 3.0 y 3.5.
        { w: 360, h: 800, dpr: 2.0, availH: 800 },
      ],
      gpus: [
        'ARM',
        'Mali-G52 MC2',
      ],
      memCores: [
        { deviceMemory: 2, cores: 8 },
        { deviceMemory: 4, cores: 8 },
      ],
    },
    {
      id: 'android-samsung-s23',
      name: 'Samsung Galaxy S23 Ultra (SM-S918B · Adreno 740)',
      platform: 'Linux armv8l',
      uaOS: 'Linux; Android 14; SM-S918B',
      reducedUA: 'Linux; Android 10; K',
      model: 'SM-S918B',
      brand: 'Samsung',
      platformVersion: '14.0.0',
      majorBase: 151,
      screens: [
        { w: 360, h: 780, dpr: 3.0, availH: 780 },
        { w: 384, h: 832, dpr: 2.8125, availH: 832 },
      ],
      gpus: [
        'Qualcomm',
        'Adreno (TM) 740',
      ],
      memCores: [
        { deviceMemory: 8, cores: 8 },
        { deviceMemory: 4, cores: 8 },
      ],
    },
    {
      id: 'android-pixel-8',
      name: 'Google Pixel 8 Pro (Pixel 8 Pro · Mali-G715)',
      platform: 'Linux armv8l',
      uaOS: 'Linux; Android 14; Pixel 8 Pro',
      reducedUA: 'Linux; Android 10; K',
      model: 'Pixel 8 Pro',
      brand: 'Google',
      platformVersion: '14.0.0',
      majorBase: 151,
      screens: [
        { w: 412, h: 915, dpr: 2.625, availH: 915 },
      ],
      gpus: [
        'ARM',
        'Mali-G715-Immortalis MC10',
      ],
      memCores: [
        { deviceMemory: 8, cores: 8 },
      ],
    },
    {
      id: 'android-xiaomi-13',
      name: 'Xiaomi 13 Pro (2210132G · Adreno 740)',
      platform: 'Linux armv8l',
      uaOS: 'Linux; Android 13; 2210132G',
      reducedUA: 'Linux; Android 10; K',
      model: '2210132G',
      brand: 'Xiaomi',
      platformVersion: '13.0.0',
      majorBase: 150,
      screens: [
        { w: 393, h: 851, dpr: 2.75, availH: 851 },
      ],
      gpus: [
        'Qualcomm',
        'Adreno (TM) 740',
      ],
      memCores: [
        { deviceMemory: 8, cores: 8 },
        { deviceMemory: 4, cores: 8 },
      ],
    },
  ],

  ios: [
    {
      id: 'ios-iphone-15-pro',
      name: 'Apple iPhone 15 Pro Max (iOS 17.4 · A17 Pro)',
      platform: 'iPhone',
      uaOS: 'iPhone; CPU iPhone OS 17_4 like Mac OS X',
      platformVersion: '17.4',
      majorBase: 150,
      screens: [
        { w: 430, h: 932, dpr: 3.0, availH: 932 },
        { w: 393, h: 852, dpr: 3.0, availH: 852 },
      ],
      gpus: [
        'Apple GPU',
        'Apple A17 Pro GPU',
      ],
      memCores: [
        { deviceMemory: 8, cores: 6 },
      ],
    },
    {
      id: 'ios-iphone-14',
      name: 'Apple iPhone 14 (iOS 16.6 · A15 Bionic)',
      platform: 'iPhone',
      uaOS: 'iPhone; CPU iPhone OS 16_6 like Mac OS X',
      platformVersion: '16.6',
      majorBase: 149,
      screens: [
        { w: 390, h: 844, dpr: 3.0, availH: 844 },
      ],
      gpus: [
        'Apple GPU',
        'Apple A15 GPU',
      ],
      memCores: [
        { deviceMemory: 4, cores: 6 },
      ],
    },
  ],
};

export const TIMEZONES = [
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/Mexico_City', 'America/Bogota', 'America/Lima', 'America/Santiago',
  'America/Sao_Paulo', 'Europe/Madrid', 'Europe/Paris', 'Europe/London', 'Europe/Berlin',
  'Europe/Amsterdam', 'Europe/Rome', 'Europe/Warsaw', 'Asia/Tokyo', 'Asia/Seoul',
  'Asia/Shanghai', 'Asia/Singapore', 'Australia/Sydney', 'Pacific/Auckland',
];

export const LANGS = [
  'es-ES,es;q=0.9,en;q=0.8',
  'es-MX,es-419;q=0.9,es;q=0.8,en;q=0.7',
  'es-CO,es-419;q=0.9,es;q=0.8',
  'es-AR,es-419;q=0.9,es;q=0.8',
  'en-US,en;q=0.9',
  'en-GB,en;q=0.9,en-US;q=0.8',
  'pt-BR,pt;q=0.9,en-US;q=0.8',
  'fr-FR,fr;q=0.9,en;q=0.8',
  'de-DE,de;q=0.9,en;q=0.8',
  'it-IT,it;q=0.9,en;q=0.8',
];

export function fnv1a32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

function pick(h, i, n) { return (Math.imul(h ^ (i * 0x9E3779B1), 0x85EBCA6B) >>> 0) % n; }

/**
 * Builds a 100% coherent identity matching OS, Device, and chosen Browser Brand.
 */
export function buildIdentity(options = {}) {
  const seed = options.seed || Math.floor(Math.random() * 0xFFFFFFFF);
  const osKey = (options.os || 'android').toLowerCase();
  const browserKey = (options.browser || (osKey === 'android' ? 'chrome' : 'chrome')).toLowerCase();

  const kitList = KITS[osKey] || KITS.windows;
  const kit = options.kitId 
    ? (kitList.find(k => k.id === options.kitId) || kitList[0])
    : kitList[pick(seed, 1, kitList.length)];

  const screen = kit.screens[pick(seed, 2, kit.screens.length)];
  const gpu = kit.gpus[pick(seed, 3, kit.gpus.length)];
  const mc = kit.memCores[pick(seed, 4, kit.memCores.length)];
  const tz = options.timezone || TIMEZONES[pick(seed, 5, TIMEZONES.length)];
  const lang = options.lang || LANGS[pick(seed, 6, LANGS.length)];

  const isMobile = osKey === 'android' || osKey === 'ios';
  const major = options.engineVersion ? parseInt(options.engineVersion, 10) : kit.majorBase;
  const patch = pick(seed * 2654435761 >>> 0, 7, 99) + 1;
  const build = pick(seed >>> 1, 8, 9);
  const fullVersion = `${major}.0.${build}.${patch}`;

  // UA String & Client Hints Construction based on Browser Type
  let ua = '';
  let brands = [];

  const uaOsPart = isMobile ? (kit.reducedUA || 'Linux; Android 10; K') : kit.uaOS;

  if (browserKey === 'edge') {
    ua = `Mozilla/5.0 (${uaOsPart}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${fullVersion} Safari/537.36 Edg/${major}.0.0.0`;
    brands = [
      { brand: 'Not=A?Brand', version: '99' },
      { brand: 'Chromium', version: String(major) },
      { brand: 'Microsoft Edge', version: String(major) },
    ];
  } else if (browserKey === 'opera') {
    const operaVer = `${major - 18}.0.0.0`;
    ua = `Mozilla/5.0 (${uaOsPart}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${fullVersion} Safari/537.36 OPR/${operaVer}`;
    brands = [
      { brand: 'Not=A?Brand', version: '99' },
      { brand: 'Chromium', version: String(major) },
      { brand: 'Opera', version: String(major) },
    ];
  } else if (browserKey === 'samsung') {
    ua = `Mozilla/5.0 (${uaOsPart}) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/24.0 Chrome/${fullVersion} Mobile Safari/537.36`;
    brands = [
      { brand: 'Not=A?Brand', version: '99' },
      { brand: 'Chromium', version: String(major) },
      { brand: 'Samsung Internet', version: '24' },
    ];
  } else if (browserKey === 'firefox') {
    const ffVer = `${major - 15}.0`;
    if (isMobile) {
      ua = `Mozilla/5.0 (Android 12; Mobile; rv:${ffVer}) Gecko/${ffVer} Firefox/${ffVer}`;
    } else {
      ua = `Mozilla/5.0 (${kit.uaOS}; rv:${ffVer}) Gecko/20100101 Firefox/${ffVer}`;
    }
    brands = []; // Firefox does NOT send Sec-Ch-Ua
  } else if (browserKey === 'safari') {
    if (isMobile) {
      ua = `Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1`;
    } else {
      ua = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15`;
    }
    brands = []; // Safari does NOT send Sec-Ch-Ua
  } else {
    // Standard Google Chrome (Default & Highest Trust)
    const mobileTag = isMobile ? ' Mobile ' : ' ';
    ua = `Mozilla/5.0 (${uaOsPart}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${fullVersion}${mobileTag}Safari/537.36`;
    brands = [
      { brand: 'Not=A?Brand', version: '99' },
      { brand: 'Chromium', version: String(major) },
      { brand: 'Google Chrome', version: String(major) },
    ];
  }

  return {
    seed,
    os: osKey,
    browser: browserKey,
    kitId: kit.id,
    kitName: kit.name,
    model: kit.model || '',
    brand: kit.brand || '',
    ua,
    major,
    fullVersion,
    brands,
    platform: kit.platform,
    platformVersion: kit.platformVersion,
    screen,
    gpu,
    deviceMemory: mc.deviceMemory,
    hardwareConcurrency: mc.cores,
    maxTouchPoints: isMobile ? 5 : 0,
    timezone: tz,
    lang,
  };
}

/**
 * Lists available kits formatted for UI selection.
 */
export function listAvailableKits(osKey) {
  if (osKey && KITS[osKey]) {
    return KITS[osKey];
  }
  return KITS;
}