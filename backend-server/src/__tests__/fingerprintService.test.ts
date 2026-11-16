import {
  select,
  fnv1a32,
  autoOs,
  computeFingerprint,
  countryGeo,
  geoForSeed,
  GEOS,
  timezoneForCountry,
  resolveOs,
  isOsKey,
  OS_KEYS,
} from '../services/fingerprintService';
import type { OsKey } from '../services/fingerprintService';
import fs from 'fs';
import path from 'path';

// Goldens de REGRESIÓN del catálogo del backend. No son paridad con pools.rs:
// el catálogo del backend es más amplio y puede divergir. Lo que sí comparten
// es el algoritmo (`fmix32` + Lemire) y la tabla de regiones.
// Formato: (os, seed, kit, version, major, sw, sh, dpr, mem, cores, tz, lang)
const GOLDENS: [OsKey, number, string, string, number, number, number, number, number, number, string, string][] = [
  ['windows', 42, 'win11-25h2-laptop', '156.0.6.87', 156, 1920, 1080, 1, 8, 16, 'America/Santiago', 'es-CL'],
  ['windows', 1337, 'win10-22h2-office', '156.0.4.64', 156, 1280, 1024, 1, 8, 4, 'America/Lima', 'es-PE'],
  ['windows', 777999, 'win11-23h2', '156.0.1.46', 156, 1280, 720, 1, 8, 12, 'Europe/Madrid', 'es-ES'],
  ['linux', 42, 'ubuntu-server-24.04', '156.0.6.87', 156, 1024, 768, 1, 4, 4, 'America/Santiago', 'es-CL'],
  ['linux', 1337, 'linux-hidpi-laptop', '156.0.4.64', 156, 1680, 1050, 1.5, 8, 8, 'America/Lima', 'es-PE'],
  ['linux', 777999, 'arch-linux', '156.0.1.46', 156, 3440, 1440, 1, 8, 16, 'Europe/Madrid', 'es-ES'],
  ['macos', 42, 'mac26-tahoe-m3pro', '156.0.6.87', 156, 3024, 1964, 2, 8, 20, 'America/Santiago', 'es-CL'],
  ['macos', 1337, 'macbook-air-m2', '156.0.4.64', 156, 1680, 1050, 2, 8, 8, 'America/Lima', 'es-PE'],
  ['macos', 777999, 'mac14-sonoma', '156.0.1.46', 156, 1280, 800, 2, 4, 8, 'Europe/Madrid', 'es-ES'],
];

describe('paridad de algoritmo y regresión del catálogo', () => {
  it.each(GOLDENS)('%s seed=%d', (os, seed, kit, fv, major, sw, sh, dpr, mem, cores, tz, lang) => {
    const id = select(seed, os);
    expect(id.kitId).toBe(kit);
    expect(id.fullVersion).toBe(fv);
    expect(id.major).toBe(major);
    expect(id.screenWidth).toBe(sw);
    expect(id.screenHeight).toBe(sh);
    expect(id.devicePixelRatio).toBe(dpr);
    expect(id.deviceMemory).toBe(mem);
    expect(id.cores).toBe(cores);
    expect(id.timezone).toBe(tz);
    expect(id.language).toBe(lang);
  });
});

describe('fnv1a32 (cdp.rs)', () => {
  it('paridad con valores calculados en Rust', () => {
    // Calculados previamente con el mismo algoritmo; los fijamos aquí como golden.
    expect(fnv1a32('6aa8d4e65a7a287c0aac87a6')).toBe(118732401);
    expect(fnv1a32('6a988dffde096fc618cce833')).toBe(2121602580);
    expect(fnv1a32('000000000000000000000000')).toBe(1411047717);
    expect(fnv1a32('')).toBe(2166136261);
  });

  it('rango u32 y estable', () => {
    const a = fnv1a32('abc');
    const b = fnv1a32('abc');
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThanOrEqual(4294967295);
    expect(fnv1a32('abc')).not.toBe(fnv1a32('abd'));
  });
});

describe('autoOs (backend.rs FNV-1a 64 % 100)', () => {
  it('solo devuelve windows/macos/linux y es estable', () => {
    for (let i = 0; i < 200; i++) {
      const id = `${i}`.padStart(24, '0');
      const os = autoOs(id);
      expect(['windows', 'macos', 'linux']).toContain(os);
      expect(autoOs(id)).toBe(os);
    }
  });
});

describe('computeFingerprint (receta completa)', () => {
  it('u32 seed = fnv1a32(profileId) y os = autoOs(profileId)', () => {
    const fp = computeFingerprint('6aa8d4e65a7a287c0aac87a6');
    expect(fp.seed).toBe(fnv1a32('6aa8d4e65a7a287c0aac87a6'));
    expect(fp.os).toBe(autoOs('6aa8d4e65a7a287c0aac87a6'));
    expect(fp.identity).toEqual(select(fp.seed, fp.os));
  });
});

describe('resolveOs (de dónde sale el SO del perfil)', () => {
  const ID = '6aa8d4e65a7a287c0aac87a6';

  it('lo guardado gana siempre: es lo que da estabilidad', () => {
    const r = resolveOs({ profileId: ID, stored: 'linux', requested: 'macos', device: 'windows' });
    expect(r).toEqual({ os: 'linux', source: 'stored' });
  });

  it('si no hay nada guardado, gana lo que pide el cliente', () => {
    expect(resolveOs({ profileId: ID, requested: 'android' })).toEqual({
      os: 'android',
      source: 'requested',
    });
  });

  it('un os inválido NO se cuela como si fuera válido', () => {
    // Mayúsculas, espacios, typos: todo eso cae al siguiente escalón en vez de
    // colarse. 'Windows' con mayúscula es el caso real, porque es lo que
    // escribiría un cliente.
    for (const bad of ['Windows', 'win', 'WINDOWS', 'mac', 'android-13', '', 42, null, {}]) {
      expect(isOsKey(bad)).toBe(false);
    }
    const r = resolveOs({ profileId: ID, requested: 'Windows', device: 'macos' });
    expect(r).toEqual({ os: 'macos', source: 'device' });
  });

  it('la cabecera del dispositivo sirve cuando el cliente no manda os', () => {
    expect(resolveOs({ profileId: ID, device: 'MACOS' })).toEqual({ os: 'macos', source: 'device' });
    expect(resolveOs({ profileId: ID, device: 'unknown' }).source).toBe('auto');
  });

  it('el sorteo es el último recurso, y es el de siempre', () => {
    const r = resolveOs({ profileId: ID });
    expect(r.source).toBe('auto');
    expect(r.os).toBe(autoOs(ID));
  });

  it('es determinista: el mismo perfil sin os da siempre lo mismo', () => {
    expect(resolveOs({ profileId: ID }).os).toBe(resolveOs({ profileId: ID }).os);
  });
});

describe('computeFingerprint con os explícito', () => {
  const ID = '6aa8d4e65a7a287c0aac87a6';

  it('respeta el SO pedido en vez de sortearlo', () => {
    const fp = computeFingerprint(ID, 'macos');
    expect(fp.os).toBe('macos');
    expect(fp.identity).toEqual(select(fp.seed, 'macos'));
    expect(fp.seed).toBe(fnv1a32(ID));
  });

  it('el mismo id con distinto SO da recetas distintas (familias distintas)', () => {
    const win = computeFingerprint(ID, 'windows');
    const mac = computeFingerprint(ID, 'macos');
    expect(win.identity.uaOs).not.toBe(mac.identity.uaOs);
    expect(win.identity.platform).toBe('Win32');
    expect(mac.identity.platform).toBe('MacIntel');
  });

  it('sin os sigue el sorteo de siempre (compatibilidad con clientes viejos)', () => {
    expect(computeFingerprint(ID).os).toBe(autoOs(ID));
    // Un os basura también cae al sorteo, no rompe nada.
    expect(computeFingerprint(ID, 'Solaris' as any).os).toBe(autoOs(ID));
  });

  it('los cinco SO producen una identidad completa y coherente', () => {
    for (const os of OS_KEYS) {
      const fp = computeFingerprint(ID, os);
      expect(fp.identity.kitId).toBeTruthy();
      expect(fp.identity.screenWidth).toBeGreaterThan(0);
      expect(fp.identity.deviceMemory).toBeGreaterThan(0);
      expect(fp.identity.cores).toBeGreaterThan(0);
      expect(fp.identity.timezone).toMatch(/\//);
      expect(fp.identity.language).toMatch('-');
    }
  });
});

/**
 * Con el segundo generador eliminado (03/10/2026), esta es la única fuente de
 * identidad del backend. Estos tests comprueban que A es coherente consigo misma:
 * que platform, uaOs, platformVersion y kit pertenezcan al MISMO sistema, y que
 * la receta no cambie entre llamadas. Antes estas coherencias no se podían
 * comprobar porque había dos generadores que responder por el mismo perfil.
 */
// Copia local de las pantallas por kit de Android, para el test de arriba. Se
// duplica a proposito en vez de exportar la tabla: el test debe poder detectar
// que la tabla del servicio cambia, no compararse con ella.
const ANDROID_KIT_SCREENS: Record<string, string[]> = {
  'android-pixel-8': ['412x915@2.625'],
  'android-xiaomi-13': ['393x851@2.75'],
};

describe('coherencia interna de la receta', () => {
  const IDS = Array.from({ length: 300 }, (_, i) => (i + 1).toString(16).padStart(24, '0'));

  it('platform, uaOs, platformVersion y kit son del mismo sistema', () => {
    const EXPECTED: Record<OsKey, { platform: string; ua: RegExp }> = {
      windows: { platform: 'Win32', ua: /Windows NT/ },
      macos: { platform: 'MacIntel', ua: /Macintosh/ },
      linux: { platform: 'Linux x86_64', ua: /X11; Linux/ },
      android: { platform: 'Linux armv81', ua: /Android/ },
      ios: { platform: 'iPhone', ua: /iPhone/ },
    };

    for (const os of OS_KEYS) {
      const exp = EXPECTED[os];
      for (const id of IDS) {
        const f = select(fnv1a32(id), os);
        expect(f.platform).toBe(exp.platform);
        expect(f.uaOs).toMatch(exp.ua);
        // platformVersion es POR KIT y tiene que concordar con el SO que dice
        // la UA. No se fija aquí un valor: fijarlo fue justamente lo que
        // permitió que los kits Android declararan Android 10 en la UA y 12.0.0
        // en Client Hints. La concordancia se comprueba más abajo.
        expect(f.platformVersion).toMatch(/^\d+(\.\d+)+$/);
      }
    }
  });

  it('el kit pertenece a la familia del SO pedido', () => {
    // El prefijo del id ya no basta para saberlo: Linux tiene 13 kits y cinco
    // prefijos distintos (ubuntu, fedora, debian, arch, linux-). Lo que
    // demuestra que el kit es de la familia correcta es la plataforma que
    // devuelve la receta, no el nombre.
    const esperado: Record<OsKey, string> = {
      windows: 'Win32',
      macos: 'MacIntel',
      linux: 'Linux x86_64',
      android: 'Linux armv81',
      ios: 'iPhone',
    };
    for (const id of IDS) {
      for (const os of OS_KEYS) {
        expect(select(fnv1a32(id), os).platform).toBe(esperado[os]);
      }
    }
  });

  it('mismo profileId + mismo SO = misma receta, siempre', () => {
    for (const id of IDS.slice(0, 50)) {
      for (const os of OS_KEYS) {
        expect(computeFingerprint(id, os)).toEqual(computeFingerprint(id, os));
      }
    }
  });

  it('la pantalla del kit y su memoria salen del kit, no de una lista global', () => {
    // Si un kit declara una sola pantalla, todos los perfiles de ese kit deben
    // acabar en esa pantalla. Antes se elegía de un SCREENS global, así que un
    // perfil Nokia podía salir con 3840x2160.
    for (const id of IDS) {
      const f = select(fnv1a32(id), 'android');
      const kit = ANDROID_KIT_SCREENS[f.kitId];
      if (kit && kit.length === 1) {
        expect(`${f.screenWidth}x${f.screenHeight}@${f.devicePixelRatio}`).toBe(kit[0]);
      }
    }
  });

  it('un SO distinto produce una receta distinta (no dos SO con el mismo seed)', () => {
    const id = IDS[0];
    const results = OS_KEYS.map((os) => JSON.stringify(computeFingerprint(id, os).identity));
    expect(new Set(results).size).toBe(OS_KEYS.length);
  });
});

/**
 * `navigator.deviceMemory` no es la RAM del equipo: es la RAM redondeada a
 * potencia de dos y RECORTADA A 8 GiB por la especificación de Device Memory,
 * precisamente para reducir el fingerprint. Chrome no puede devolver 12, ni 16,
 * ni 32, ni 3, ni 6.
 *
 * Antes el catálogo declaraba valores así en 9 de los 13 kits, y se leía con
 * una sola línea de JavaScript. Cualquier sitio que compare contra el conjunto
 * válido lo tenía listo.
 */
const DEVICE_MEMORY_VALIDOS = [0.25, 0.5, 1, 2, 4, 8];

describe('deviceMemory respeta la especificación', () => {
  /** Devuelve la lista de (seed, kit, memoria) que ningún Chrome podría dar. */
  function infractores(): string[] {
    const malos: string[] = [];
    for (let i = 1; i <= 500; i++) {
      const id = i.toString(16).padStart(24, '0');
      for (const os of OS_KEYS) {
        const seed = fnv1a32(id);
        const f = select(seed, os);
        if (!DEVICE_MEMORY_VALIDOS.includes(f.deviceMemory)) {
          malos.push(`${os} seed ${seed} (${f.kitId}) → deviceMemory ${f.deviceMemory}`);
        }
      }
    }
    return malos;
  }

  it('el catálogo entero respeta el conjunto de valores que Chrome puede devolver', () => {
    // 500 ids x 5 SOS = 2500 identidades. El fallo estaba en la TABLA, no en un
    // seed concreto, así que esto recorre el catálogo entero en vez de probar
    // unos pocos casos.
    const malos = infractores();
    expect(
      malos.slice(0, 8)
    ).toEqual([]);
    expect(malos.length).toBe(0);
  });

  it('declaration en el propio servicio, para no depender de los seeds', () => {
    for (const os of OS_KEYS) {
      for (const seed of [0, 1, 42, 1337, 99991, 0xffffffff]) {
        expect(DEVICE_MEMORY_VALIDOS).toContain(select(seed, os).deviceMemory);
      }
    }
  });

  it('los núcleos siguen siendo verosímiles (no se tocaron al corregir)', () => {
    const f = select(fnv1a32('6aa8d4e65a7a287c0aac87a6'), 'windows');
    expect(f.cores).toBeGreaterThanOrEqual(2);
    expect(f.cores).toBeLessThanOrEqual(64);
  });
});

/**
 * Un perfil no es un kitty: su token de UA, su plataforma, su versión de SO, su
 * pantalla, su DPR y sus núcleos tienen que poder existir en el MISMO aparato.
 *
 * Estas reglas se escribieron después de encontrar que los cuatro kits Android
 * declaraban `Android 10` en la UA y `12.0.0` en Client Hints, en la misma
 * respuesta. Se comprueban sobre el catálogo entero, no sobre unos seeds: el
 * fallo estaba en la tabla.
 */
const FAMILIAS: Record<OsKey, { dpr: [number, number]; ancho: [number, number]; moviles: boolean }> = {
  windows: { dpr: [1.0, 1.5], ancho: [1024, 4096], moviles: false },
  // macOS tiene HiDPI de serie: 2.0 en todos los Mac desde 2012.
  macos: { dpr: [1.0, 2.0], ancho: [1280, 3456], moviles: false },
  // Linux puede declarar 1.25 o 1.5 con escalado fraccionario de X11.
  linux: { dpr: [1.0, 2.0], ancho: [1024, 3840], moviles: false },
  // El rango es AMPLIO a propósito. Antes se exigía 2.0-3.5 y se descartó el
  // 1.875 del Galaxy A12 por "no ser un DPR que Android pueda reportar". Era
  // falso: el móvil real lo reporta, y 385x854 a 1.875 es exactamente su
  // pantalla. Los buckets de densidad de Android no son solo 1.0/1.5/2.0.
  android: { dpr: [1.75, 4.0], ancho: [320, 480], moviles: true },
  ios: { dpr: [2.0, 3.0], ancho: [320, 440], moviles: true },
};

describe('coherencia del catálogo: nada puede existir solo en un campo', () => {
  /** Todas las identidades que el catálogo puede producir. */
  function todas(): { os: OsKey; seed: number; id: ReturnType<typeof select> }[] {
    const salida = [];
    for (let i = 1; i <= 400; i++) {
      const seed = (i * 2654435761) >>> 0;
      for (const os of OS_KEYS) {
        salida.push({ os, seed, id: select(seed, os) });
      }
    }
    return salida;
  }

  it('la versión de SO de la UA es la misma que la de Client Hints', () => {
    const fallos: string[] = [];
    for (const { os, id } of todas()) {
      const android = /Android (\d+)/.exec(id.uaOs);
      if (android && !id.platformVersion.startsWith(android[1] + '.')) {
        fallos.push(`${id.kitId}: UA dice Android ${android[1]}, Client Hints ${id.platformVersion}`);
      }
      const ios = /iPhone OS (\d+)[_.]/.exec(id.uaOs);
      if (ios && !id.platformVersion.replace(/_/g, '.').startsWith(ios[1] + '.')) {
        fallos.push(`${id.kitId}: UA dice iOS ${ios[1]}, Client Hints ${id.platformVersion}`);
      }
    }
    expect(fallos.slice(0, 6)).toEqual([]);
    expect(fallos.length).toBe(0);
  });

  it('el DPR está dentro de lo que la familia puede declarar', () => {
    const fallos: string[] = [];
    for (const { os, id } of todas()) {
      const [lo, hi] = FAMILIAS[os].dpr;
      if (id.devicePixelRatio < lo || id.devicePixelRatio > hi) {
        fallos.push(`${id.kitId}: dpr ${id.devicePixelRatio} fuera de ${lo}-${hi}`);
      }
    }
    expect(fallos.slice(0, 6)).toEqual([]);
    expect(fallos.length).toBe(0);
  });

  it('una pantalla de móvil no aparece en un kit de escritorio, ni al revés', () => {
    const fallos: string[] = [];
    for (const { os, id } of todas()) {
      const [lo, hi] = FAMILIAS[os].ancho;
      if (id.screenWidth < lo || id.screenWidth > hi) {
        fallos.push(
          `${id.kitId} (${os}): ${id.screenWidth}x${id.screenHeight} no pertenece a la familia`
        );
      }
    }
    expect(fallos.slice(0, 6)).toEqual([]);
    expect(fallos.length).toBe(0);
  });

  it('dos kits del mismo SO no son el mismo kit con otro nombre', () => {
    // Solo se exige que no sean COMPLETAMENTE idénticos: mismo token de UA y
    // mismo conjunto de pantallas.
    //
    // Se podría ser más estricto y exigir que ninguna combinación se repita
    // entre kits, pero eso sería un error: todas las máquinas Windows reportan
    // `Windows NT 10.0; Win64; x64` (Chrome congeló ese token) y dos equipos
    // distintos pueden tener 1366x768 los dos. Compartir eso no es un defecto,
    // es lo que hace un Windows real. Exigir más obligaría a inventar datos.
    const porOs = new Map<OsKey, Map<string, Set<string>>>();
    for (const os of OS_KEYS) {
      const kits = new Map<string, Set<string>>();
      for (let i = 1; i <= 400; i++) {
        const id = select((i * 2654435761) >>> 0, os);
        if (!kits.has(id.kitId)) kits.set(id.kitId, new Set());
        kits.get(id.kitId)!.add(`${id.uaOs}|${id.screenWidth}x${id.screenHeight}`);
      }
      porOs.set(os, kits);
    }

    const fallos: string[] = [];
    for (const [os, kits] of porOs) {
      const ids = [...kits.keys()];
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const a = kits.get(ids[i])!;
          const b = kits.get(ids[j])!;
          if (a.size === b.size && [...a].every((x) => b.has(x))) {
            fallos.push(`${os}: ${ids[i]} y ${ids[j]} son idénticos`);
          }
        }
      }
    }
    expect(fallos.slice(0, 6)).toEqual([]);
    expect(fallos.length).toBe(0);
  });
});

describe('coherencia timezone <-> idioma <-> versión', () => {
  it('toda pareja generada pertenece a una región del catálogo', () => {
    const validas = new Set(
      GEOS.flatMap((geo) => geo.languages.map((lang) => `${geo.timezone}|${lang}`)),
    );
    const fallos: string[] = [];

    for (let i = 0; i < 20_000; i++) {
      const seed = (i * 2654435761) >>> 0;
      for (const os of OS_KEYS) {
        const id = select(seed, os);
        if (!validas.has(`${id.timezone}|${id.language}`)) {
          fallos.push(`${os} seed=${seed}: ${id.timezone} + ${id.language}`);
        }
      }
    }

    expect(fallos.slice(0, 8)).toEqual([]);
    expect(fallos.length).toBe(0);
  });

  it('la región del seed es estable y queda dentro del catálogo', () => {
    const ids = new Set(GEOS.map((geo) => geo.id));
    for (let seed = 0; seed < 5_000; seed++) {
      expect(ids.has(geoForSeed(seed).id)).toBe(true);
      expect(geoForSeed(seed)).toBe(geoForSeed(seed));
    }
  });

  it('nunca anuncia un Chrome distinto del motor real', () => {
    // El major se lee de pools.rs en lugar de fijarlo aquí: al subir el motor a
    // 156 este test seguía esperando 154 y quedó en rojo.
    const poolsRs = fs.readFileSync(
      path.join(__dirname, '../../../app-client-desktop-and-mobile/src-tauri/src/pools.rs'),
      'utf8',
    );
    const engineMajor = Number(poolsRs.match(/pub const DEFAULT_MAJOR: u32 = (\d+);/)![1]);
    for (let seed = 0; seed < 2_000; seed++) {
      for (const os of OS_KEYS) {
        const id = select(seed, os);
        expect(id.major).toBe(engineMajor);
        expect(id.fullVersion.startsWith(`${engineMajor}.`)).toBe(true);
      }
    }
  });

  it('el país cambia timezone e idioma juntos', () => {
    for (const [cc, geo] of countryGeo) {
      expect(cc).toMatch(/^[A-Z]{2}$/);
      expect(geo.timezone).toMatch(/^[A-Za-z_\-]+(?:\/[A-Za-z_\-]+)+$/);
      expect(geo.language).toMatch(/^[a-z]{2,3}(?:-[A-Z]{2})?$/);
    }
    expect(countryGeo.get('SE')).toEqual({ timezone: 'Europe/Stockholm', language: 'sv-SE' });
    expect(countryGeo.get('JP')).toEqual({ timezone: 'Asia/Tokyo', language: 'ja-JP' });
    expect(countryGeo.get('MX')).toEqual({ timezone: 'America/Mexico_City', language: 'es-MX' });
  });
});

describe('timezoneForCountry (tz alineado al egress)', () => {
  it('países conocidos dan una zona IANA válida', () => {
    for (const [cc, tz] of timezoneForCountry) {
      expect(cc).toMatch(/^[A-Z]{2}$/);
      expect(tz).toMatch(/^[A-Za-z_\-]+(?:\/[A-Za-z_\-]+)+$/);
    }
  });

  it('override del tz por país: MX -> Mexico_City, JP -> Tokyo, ES -> Madrid', () => {
    expect(timezoneForCountry.get('MX')).toBe('America/Mexico_City');
    expect(timezoneForCountry.get('JP')).toBe('Asia/Tokyo');
    expect(timezoneForCountry.get('ES')).toBe('Europe/Madrid');
  });

  it('el tz del país solo sustituye timezone; seed y os no cambian', () => {
    const fp = computeFingerprint('6aa8d4e65a7a287c0aac87a6');
    const country = timezoneForCountry.get('MX')!;
    fp.identity.timezone = country;
    expect(fp.seed).toBe(fnv1a32('6aa8d4e65a7a287c0aac87a6'));
    expect(fp.os).toBe(autoOs('6aa8d4e65a7a287c0aac87a6'));
    expect(fp.identity.timezone).toBe('America/Mexico_City');
  });
});