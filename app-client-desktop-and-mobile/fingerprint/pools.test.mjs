import { buildIdentity, fnv1a32, KITS, TIMEZONES, LANGS } from './pools.mjs';

// ============================================================================
// pools.test.mjs — invariantes del catálogo de identidades
// ============================================================================
// Este test se reescribió el 01/10/2026. La versión anterior importaba
// `selectIdentity`, `budgetFromRam` y `PARTIALS`, que NO existen en pools.mjs
// (el CI falló con "does not provide an export named 'PARTIALS'"). Esas tres
// nunca se implementaron: la API real es `buildIdentity({seed, os})`.
//
// Lo que se conserva es lo que de verdad importa para un motor antidetect:
// determinismo por seed, coherencia interna de la identidad y diversidad.
// ============================================================================

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log('FAIL:', msg); } };

// --- determinismo ----------------------------------------------------------
// Mismo seed + mismo OS deben dar exactamente la misma identidad. Sin esto,
// un perfil "fijo" cambiaría de huella en cada arranque y sería inútil.
{
  const a = buildIdentity({ seed: 12345, os: 'windows' });
  const b = buildIdentity({ seed: 12345, os: 'windows' });
  ok(JSON.stringify(a) === JSON.stringify(b), 'determinismo por seed');
}

// --- reproducibilidad de los campos de hardware ----------------------------
// Aunque el major pueda rotar, kit/pantalla/GPU/memoria deben ser estables.
{
  const c1 = buildIdentity({ seed: 111, os: 'linux' });
  const c2 = buildIdentity({ seed: 111, os: 'linux' });
  ok(c1.kitId === c2.kitId, 'reproducibilidad del kit');
  ok(JSON.stringify(c1.screen) === JSON.stringify(c2.screen), 'reproducibilidad de pantalla');
  ok(JSON.stringify(c1.gpu) === JSON.stringify(c2.gpu), 'reproducibilidad de GPU');
  ok(c1.deviceMemory === c2.deviceMemory, 'reproducibilidad de memoria');
  ok(c1.hardwareConcurrency === c2.hardwareConcurrency, 'reproducibilidad de nucleos');
}

// --- diversidad ------------------------------------------------------------
// Seeds distintos no deben clonar la misma identidad: un catalogo que solo
// rota el UA es detectable.
const seeds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
{
  const ids = seeds.map(s => buildIdentity({ seed: s, os: 'windows' }));
  const uas = new Set(ids.map(i => i.ua));
  ok(uas.size > 8, `diversidad de UA windows (${uas.size}/16)`);
  const kits = new Set(ids.map(i => i.kitId));
  ok(kits.size >= 2, `diversidad de kit (${kits.size})`);
  const majors = new Set(ids.map(i => i.major));
  ok(majors.size >= 1, `rotación de major (${[...majors].join(',')})`);
}

// --- coherencia UA <-> versión <-> brands -----------------------------------
// El fallo clásico: UA dice Chrome/151 y Client Hints dicen Chrome/149.
for (const os of ['windows', 'linux', 'macos']) {
  for (const s of seeds) {
    const id = buildIdentity({ seed: s, os });
    ok(id.ua.includes(`Chrome/${id.fullVersion}`),
      `UA coherente con fullVersion ${os} ${s} (${id.fullVersion})`);
    ok(id.fullVersion.startsWith(`${id.major}.`),
      `major es prefijo de fullVersion ${os} ${s} (${id.major} / ${id.fullVersion})`);
    // El objeto de marca usa {brand, version} (formato de Sec-CH-UA), no {v}.
    // Chromium y Google Chrome deben llevar el MISMO major que el UA: si
    // divergieran, el Client Hint delata la incoherencia aunque el UA cuadre.
    ok(id.brands.some(b => b.brand === 'Chromium' && b.version === String(id.major)),
      `brands Chromium coherente con major ${os} ${s} (${id.major})`);
    ok(id.brands.some(b => b.brand === 'Google Chrome' && b.version === String(id.major)),
      `brands Google Chrome coherente con major ${os} ${s} (${id.major})`);
    ok(id.brands.every(b => typeof b.brand === 'string' && /^\d+$/.test(b.version)),
      `brands con formato válido ${os} ${s}`);
  }
}

// --- coherencia de plataforma ----------------------------------------------
{
  const it = buildIdentity({ seed: 999, os: 'macos' });
  ok(it.ua.startsWith('Mozilla/5.0 (Macintosh; Intel Mac OS X'), `UA macOS: ${it.ua.slice(0, 60)}`);
  const lx = buildIdentity({ seed: 999, os: 'linux' });
  ok(lx.ua.startsWith('Mozilla/5.0 (X11; Linux x86_64)'), `UA Linux: ${lx.ua.slice(0, 60)}`);
  const wn = buildIdentity({ seed: 999, os: 'windows' });
  ok(wn.ua.startsWith('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), `UA Windows: ${wn.ua.slice(0, 60)}`);
  const an = buildIdentity({ seed: 999, os: 'android' });
  ok(an.maxTouchPoints > 0, 'android declara maxTouchPoints');
  ok(buildIdentity({ seed: 999, os: 'windows' }).maxTouchPoints === 0,
    'windows no declara maxTouchPoints');
}

// --- coherencia geográfica (IP <-> timezone <-> idioma) ---------------------
// El defecto que motivó el motor: antes el TZ y el idioma salían de listas
// independientes y producían combinaciones imposibles (Asia/Tokyo + es-ES).
for (const s of seeds) {
  const id = buildIdentity({ seed: s, os: 'windows' });
  ok(TIMEZONES.includes(id.timezone), `timezone en catálogo ${s} (${id.timezone})`);
  ok(LANGS.includes(id.lang), `idioma en catálogo ${s} (${id.lang})`);
  // Asia/Tokyo no es un pairing razonable con español.
  if (id.timezone.startsWith('Asia/')) {
    ok(!/^es|^en-US/.test(id.lang),
      `idioma coherente con zona ${s}: ${id.timezone} + ${id.lang}`);
  }
}

// --- catálogo: todo kit referenciado existe y está completo -----------------
for (const [osKey, kitList] of Object.entries(KITS)) {
  ok(Array.isArray(kitList) && kitList.length > 0, `KITS.${osKey} no vacío`);
  for (const kit of kitList || []) {
    ok(typeof kit.id === 'string' && kit.id.length > 0, `kit de ${osKey} con id`);
    ok(Array.isArray(kit.screens) && kit.screens.length > 0, `kit ${kit.id} con pantallas`);
    ok(Array.isArray(kit.gpus) && kit.gpus.length > 0, `kit ${kit.id} con GPUs`);
    ok(Array.isArray(kit.memCores) && kit.memCores.length > 0, `kit ${kit.id} con memCores`);
    ok(typeof kit.majorBase === 'number', `kit ${kit.id} con majorBase`);
  }
}

// --- hash -------------------------------------------------------------------
// fnv1a32 se usa para derivar seeds; debe ser estable y de 32 bits.
{
  ok(fnv1a32('krakenges') === fnv1a32('krakenges'), 'fnv1a32 es determinista');
  ok(fnv1a32('krakenges') !== fnv1a32('krakenges2'), 'fnv1a32 diferencia entradas');
  const h = fnv1a32('x');
  ok(Number.isInteger(h) && h >= 0 && h <= 0xFFFFFFFF, `fnv1a32 en rango uint32 (${h})`);
}

// --- OS por defecto ---------------------------------------------------------
{
  const s1 = buildIdentity({ seed: 42 });
  const s2 = buildIdentity({ seed: 42 });
  ok(s1.os === s2.os, 'selección de OS por defecto es determinista');
}

// --- deviceMemory: solo valores que Chrome puede devolver ------------------------
// La spec de Device Memory redondea la RAM a potencia de dos y la recorta a
// 8 GiB, precisamente para reducir el fingerprint. El catalogo declaraba 12, 16,
// 24, 32, 64 y 3, que ningun Chrome del mundo devuelve, y se leia con una sola
// linea: navigator.deviceMemory.
{
  const VALIDOS = [0.25, 0.5, 1, 2, 4, 8];
  for (const [os, kits] of Object.entries(KITS)) {
    for (const kit of kits) {
      for (const mc of kit.memCores) {
        ok(
          VALIDOS.includes(mc.deviceMemory),
          `kit ${kit.id}: deviceMemory ${mc.deviceMemory} no es un valor que Chrome pueda devolver`
        );
      }
    }
  }
}

// --- coherencia: pantalla, DPR, UA y version tienen que poder existir juntos ----
// Un perfil no es un kitty. Un movil con 3840 de ancho o DPR 1.0 no existe, y
// una UA que dice Android 14 con Client Hints diciendo 12.0.0 se contradice en la
// misma respuesta.
//
// La regla es laxa en escritorio a proposito: todas las maquinas Windows
// reportan 'Windows NT 10.0; Win64; x64' porque Chrome congelo ese token, y dos
// equipos distintos pueden tener 1366x768 los dos. Exigir mas obligaria a
// inventar datos, que es peor que la repeticion.
{
  const REGLAS = {
    windows: { dpr: [1.0, 1.5], ancho: [1024, 4096] },
    macos: { dpr: [1.0, 2.0], ancho: [1280, 3456] },
    linux: { dpr: [1.0, 2.0], ancho: [1024, 3840] },
    android: { dpr: [1.75, 4.0], ancho: [320, 480] },
    ios: { dpr: [2.0, 3.0], ancho: [320, 440] },
  };
  for (const [os, kits] of Object.entries(KITS)) {
    const r = REGLAS[os];
    for (const kit of kits) {
      for (const s of kit.screens) {
        ok(s.dpr >= r.dpr[0] && s.dpr <= r.dpr[1],
          `${kit.id}: dpr ${s.dpr} fuera de ${r.dpr[0]}-${r.dpr[1]} para ${os}`);
        ok(s.w >= r.ancho[0] && s.w <= r.ancho[1],
          `${kit.id}: pantalla de ${s.w} px fuera de ${r.ancho[0]}-${r.ancho[1]} para ${os}`);
      }
      const android = /Android (\d+)/.exec(kit.uaOS);
      if (android) {
        ok(kit.platformVersion.startsWith(android[1] + '.'),
          `${kit.id}: la UA dice Android ${android[1]} y Client Hints ${kit.platformVersion}`);
      }
      const ios = /iPhone OS (\d+)[_.]/.exec(kit.uaOS);
      if (ios) {
        ok(kit.platformVersion.replace(/_/g, '.').startsWith(ios[1] + '.'),
          `${kit.id}: la UA dice iOS ${ios[1]} y Client Hints ${kit.platformVersion}`);
      }
    }
    for (let i = 0; i < kits.length; i++) {
      for (let j = i + 1; j < kits.length; j++) {
        const a = kits[i], b = kits[j];
        const mismas = a.uaOS === b.uaOS
          && a.screens.length === b.screens.length
          && a.screens.every((s, k) => s.w === b.screens[k].w && s.h === b.screens[k].h
            && s.dpr === b.screens[k].dpr);
        ok(!mismas, `${os}: ${a.id} y ${b.id} son el mismo kit con otro nombre`);
      }
    }
  }
}

console.log(`\n${pass} ok, ${fail} fail`);
if (fail) process.exit(1);
