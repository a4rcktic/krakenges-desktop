/* Validador de la receta, sin navegador y sin dependencias.
 *
 * Se ejecuta en Node (CI, o local con `node`), y comprueba que lo que el
 * catálogo declara sea algo que un Chrome real pueda decir. Es la red de
 * seguridad entre el catálogo y la página del laboratorio: si alguien añade un
 * kit con deviceMemory 16 o un UA que contradice Client Hints, esto falla
 * antes de llegar a un build.
 *
 * Uso:  node tools/fingerprint-lab/validate.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const aqui = dirname(fileURLToPath(import.meta.url));
const raiz = join(aqui, '..', '..');

// Lo que Chrome puede anunciar. La spec de Device Memory redondea a potencia de
// dos y recorta a 8 GiB para reducir el fingerprint.
const MEMORIA_VALIDA = [0.25, 0.5, 1, 2, 4, 8];

// (dprMin, dprMax, anchoMin, anchoMax)
const FAMILIA = {
  windows: { dpr: [1.0, 1.5], ancho: [1024, 4096] },
  macos:   { dpr: [1.0, 2.0], ancho: [1280, 3456] },
  linux:   { dpr: [1.0, 2.0], ancho: [1024, 3840] },
  android: { dpr: [1.75, 4.0], ancho: [320, 480] },
  ios:     { dpr: [2.0, 3.0], ancho: [320, 440] },
};

const fuente = readFileSync(
  join(raiz, 'backend-server', 'src', 'services', 'fingerprintService.ts'),
  'utf8'
);

// Extrae los kits del TypeScript sin ejecutarlo: es texto, y sólo queremos
// leerlo. Si algún día cambia la forma del catálogo, esto hay que tocarlo.
function extraer(familia) {
  const m = fuente.match(new RegExp(`const ${familia}: Kit\\[\\] = \\[(.*?)\\n\\];`, 's'));
  if (!m) throw new Error(`no se encuentra ${familia}`);
  const kits = [];
  // Un kit es una sola línea (o va envuelto en varias), pero la estructura es
  // estable: id ... platformVersion ... screens ... memCores. Se captura cada
  // campo por separado en vez de intentar emparejar corchetes anidados, que
  // antes se comía el resto de la línea.
  const re = /id: '([^']+)'[\s\S]*?platformVersion: '([^']+)'[\s\S]*?screens: (\[\[[\s\S]*?\]\])[\s\S]*?memCores: (\[\[[\s\S]*?\]\])/g;
  let k;
  while ((k = re.exec(m[1])) !== null) {
    const pantallas = [...k[3].matchAll(/\[(\d+),\s*(\d+),\s*([\d.]+)\]/g)]
      .map(([, w, h, d]) => [Number(w), Number(h), Number(d)]);
    const memCores = [...k[4].matchAll(/\[(\d+),\s*(\d+)\]/g)]
      .map(([, a, b]) => [Number(a), Number(b)]);
    const ua = /uaOs: '([^']+)'/.exec(k[0]);
    kits.push({
      id: k[1], platformVersion: k[2], uaOs: ua ? ua[1] : '',
      pantallas, memCores,
    });
  }
  return kits;
}

const fallos = [];
const avisar = (kit, msg) => fallos.push(`${kit}: ${msg}`);

let totalKits = 0;

for (const [familia, regla] of Object.entries(FAMILIA)) {
  const kits = extraer(familia.toUpperCase());
  totalKits += kits.length;

  const vistos = new Map(); // firma -> id, para detectar kits gemelos

  for (const kit of kits) {
    if (!kit.pantallas.length) avisar(kit.id, 'sin pantallas');
    if (!kit.memCores.length) avisar(kit.id, 'sin combinaciones de memoria/núcleos');

    for (const [w, h, dpr] of kit.pantallas) {
      if (dpr < regla.dpr[0] || dpr > regla.dpr[1]) {
        avisar(kit.id, `dpr ${dpr} fuera de ${regla.dpr[0]}-${regla.dpr[1]} para ${familia}`);
      }
      if (w < regla.ancho[0] || w > regla.ancho[1]) {
        avisar(kit.id, `pantalla de ${w}px fuera de ${regla.ancho[0]}-${regla.ancho[1]} para ${familia}`);
      }
    }

    for (const [mem] of kit.memCores) {
      if (!MEMORIA_VALIDA.includes(mem)) {
        avisar(kit.id, `deviceMemory ${mem} no es un valor que Chrome pueda devolver`);
      }
    }

    // La versión de SO del token de la UA debe ser la de Client Hints.
    const android = /Android (\d+)/.exec(kit.uaOs);
    if (android && !kit.platformVersion.startsWith(android[1] + '.')) {
      avisar(kit.id, `la UA dice Android ${android[1]} y Client Hints ${kit.platformVersion}`);
    }
    const ios = /iPhone OS (\d+)[_.]/.exec(kit.uaOs);
    if (ios && !kit.platformVersion.replace(/_/g, '.').startsWith(ios[1] + '.')) {
      avisar(kit.id, `la UA dice iOS ${ios[1]} y Client Hints ${kit.platformVersion}`);
    }

    // Pares memoria/núcleos repetidos: inflan el recuento y no existen.
    const vistosPar = new Set();
    for (const par of kit.memCores) {
      const k = par.join(',');
      if (vistosPar.has(k)) avisar(kit.id, `combinación repetida ${par}`);
      vistosPar.add(k);
    }

    // Kit gemelo: mismo UA y mismas pantallas = indistinguible.
    const firma = `${kit.uaOs}|${kit.pantallas.map(p => p.join('x')).sort().join(',')}`;
    if (vistos.has(firma)) avisar(kit.id, `es el mismo kit que ${vistos.get(firma)}`);
    vistos.set(firma, kit.id);
  }
}

// ── El major anunciado tiene que ser el del motor que realmente corre ────────
//
// El motor se descarga solo y va por delante de lo que anuncia el catálogo. La
// diferencia se ve en la firma TLS y en el HTTP/2, que no se falsifican desde
// JS: es una incoherencia que ningún ajuste de JavaScript puede tapar.
//
// Ya pasó: pools.rs iba por 154 y el catálogo seguía en 151. Por eso esto se
// comprueba cruzando los dos ficheros en CI, en vez de confiar en que alguien
// se acuerde de actualizar los dos a la vez.
{
  const pools = readFileSync(
    join(raiz, 'app-client-desktop-and-mobile', 'src-tauri', 'src', 'pools.rs'), 'utf8');
  const m = pools.match(/pub const DEFAULT_MAJOR: u32 = (\d+);/);
  if (!m) {
    console.error('  ✗ no se encuentra DEFAULT_MAJOR en pools.rs');
    process.exit(1);
  }
  const motor = Number(m[1]);

  const pm = fuente.match(/const PARTIALS = \[([^\]]+)\]/);
  if (!pm) {
    console.error('  ✗ no se encuentra PARTIALS en fingerprintService.ts');
    process.exit(1);
  }
  const partials = pm[1].split(',').map((x) => Number(x.trim()));

  if (!partials.includes(motor)) {
    console.error(`\n1 problema(s) en el catálogo:\n`);
    console.error(`  ✗ el motor declara Chrome ${motor} (pools.rs DEFAULT_MAJOR)`);
    console.error(`    pero el catálogo anuncia ${partials.join(', ')}`);
    console.error('');
    console.error('    Un major distinto del binario real se detecta en la firma');
    console.error('    TLS y en el HTTP/2. No lo arregla ningún ajuste de JS.\n');
    process.exit(1);
  }
  console.log(`major del motor: Chrome ${motor}, anunciado en ${partials.join(', ')} — coincide`);
}

if (fallos.length) {
  console.error(`\n${fallos.length} problema(s) en el catálogo:\n`);
  for (const f of fallos) console.error('  ✗ ' + f);
  console.error('');
  process.exit(1);
}

console.log(`catálogo OK · ${totalKits} kits, ${Object.keys(FAMILIA).length} familias`);