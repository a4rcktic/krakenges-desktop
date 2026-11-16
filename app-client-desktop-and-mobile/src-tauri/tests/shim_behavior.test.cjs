// Prueba de comportamiento del shim: verifica que la enumeración de fuentes
// solo expone las declaradas por el perfil. Se ejecuta en Node porque el motor
// Chromium no está disponible aquí.
//
// Técnica de enumeración estándar (la que usan los detectores):
//   medir un texto con 'monospace' y comparar con '"Familia", monospace'.
//   Si el ancho difiere, la familia está instalada.

const fs = require('fs');
const vm = require('vm');

const TEMPLATE = fs.readFileSync(__dirname + '/../src/injector_template.js', 'utf8');

// Fuentes realmente disponibles en el host.
//
// Importante: `ensure_fontconfig_aliases()` en launcher.rs crea alias para las
// familias "Microsoft", de modo que en el host SÍ existen Arial, Times New
// Roman, Courier New, etc. (resueltas a Liberation/Carlito/Caladea, que son
// metricamente compatibles). Esaaliasación es la que hace posible que un perfil
// Windows declare fuentes que el host puede medir de verdad.
//
// El shim no puede fabricar métricas para una fuente que el host no tiene: sólo
// evita que las fuentes EXTRA del host se filtren. Por eso el harness modela el
// host con los alias ya aplicados.
const HOST_FONTS = new Set([
  // Alias de metricas Microsoft (instalados por ensure_fontconfig_aliases).
  'Arial', 'Arial Black', 'Times New Roman', 'Courier New', 'Verdana', 'Georgia',
  'Trebuchet MS', 'Comic Sans MS', 'Impact', 'Tahoma',
  // Fuentes nativas de Linux que NO deben filtrarse en un perfil Windows.
  'DejaVu Sans', 'Liberation Sans', 'Noto Sans', 'Ubuntu', 'Lato',
]);
// Fuentes que el perfil dice emular (Windows). Debe incluir una mezcla de las
// que el host tiene via alias y las que no: el shim sólo puede proteger la
// segunda categoria.
const PROFILE_FONTS = ['Arial', 'Times New Roman', 'Georgia', 'Tahoma',
  'Segoe UI', 'Consolas', 'Calibri'];

// Anchos deterministas por familia (para que la diferencia sea detectable).
function widthFor(fontSpec) {
  const m = /([\d.]+)px\s*([\s\S]*)$/.exec(fontSpec);
  const size = parseFloat(m[1]);
  const families = m[2].split(',').map(s => s.trim().replace(/["']/g, '').trim());
  let fam = 'sans-serif';
  for (const f of families) {
    if (['monospace', 'serif', 'sans-serif', 'cursive', 'fantasy'].includes(f)) { fam = f; break; }
    if (HOST_FONTS.has(f)) { fam = f; break; }
  }
  return size * (fam === 'monospace' ? 0.6 : 1.0);
}

class FakeCtx {
  constructor() { this._font = '10px sans-serif'; }
  get font() { return this._font; }
  set font(v) { this._font = String(v); }
  // ancho "real" del host, sin shim
  _real(text) { return { width: widthFor(this._font), actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }; }
}
const origMeasure = FakeCtx.prototype.measureText;
FakeCtx.prototype.measureText = function (t) { return this._real(t); };

// Motor de audio simulado. Reproduce las PROPIEDADES que hacen útil al motor:
// produce una señal estructurada y siempre IGUAL, que es exactamente la huella
// del hardware del host que hay que romper.
//
// Se factory: cada sandbox necesita SUS PROPIAS clases, porque el shim parchea
// `ClassName.prototype`. Si dos perfiles compartieran el mismo prototype, el
// segundo parche pisaría al primero y ambos darían la misma huella.
const HOST_SIGNAL = 0.31415926;

function makeAudioClasses() {
  class FakeAudioBuffer {
    constructor(nch, len) {
      this.numberOfChannels = nch;
      this.length = len;
      this._d = new Float32Array(len).fill(HOST_SIGNAL);
    }
    getChannelData() { return this._d; }
    copyFromChannel(dest) { dest.set(this._d); }
  }
  class FakeOfflineAudioContext {
    constructor(nch, len) { this._n = nch; this._len = len; }
    startRendering() {
      return Promise.resolve(new FakeAudioBuffer(this._n, this._len));
    }
  }
  class FakeAnalyserNode {
    getFloatFrequencyData(o) { o.fill(HOST_SIGNAL); }
    getFloatTimeDomainData(o) { o.fill(HOST_SIGNAL); }
    getByteFrequencyData(o) { o.fill(128); }
  }
  return { FakeAudioBuffer, FakeOfflineAudioContext, FakeAnalyserNode };
}

function buildSandbox() {
  const sandbox = {
    Math, JSON, String, Object, Array, Number, Boolean, RegExp, Error, TypeError,
    WeakSet, WeakMap, console, isNaN, parseFloat, parseInt, encodeURIComponent, decodeURIComponent,
    Float32Array, Uint8Array, Promise,
    location: { hostname: 'ejemplo.test' },
    navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/154.0.0.0' },
    setTimeout, clearTimeout,
    Intl: Intl,
  };
  const { FakeAudioBuffer, FakeOfflineAudioContext, FakeAnalyserNode } = makeAudioClasses();
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.CanvasRenderingContext2D = FakeCtx;
  sandbox.OffscreenCanvasRenderingContext2D = class extends FakeCtx {};
  sandbox.OfflineAudioContext = FakeOfflineAudioContext;
  sandbox.AudioBuffer = FakeAudioBuffer;
  sandbox.AnalyserNode = FakeAnalyserNode;
  sandbox.document = {
    createElement: () => ({ getContext: () => null }),
    fonts: { check: (font) => /["']?([A-Za-z ]+)/.exec(font || '') && HOST_FONTS.has(RegExp.$1) },
    documentElement: { style: { setProperty: () => {} } },
  };
  return sandbox;
}

function runShim(config) {
  const sandbox = buildSandbox();
  const src = TEMPLATE.replace('__CONFIG_JSON__', JSON.stringify(config));
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'injector.js' });
  return sandbox;
}

const CANDIDATES = [
  // Del perfil (deben detectarse)
  'Arial', 'Segoe UI', 'Consolas', 'Calibri', 'Times New Roman', 'Tahoma', 'Georgia',
  // Del host Linux que NO son parte del perfil (NO deben detectarse)
  'DejaVu Sans', 'Noto Sans', 'Ubuntu', 'Lato', 'Liberation Sans',
  // Absentes en ambos (NO deben detectarse)
  'Papyrus', 'Comic Papyrus', 'Wingdings', 'Inter', 'Roboto',
];

function enumerateFonts(ctx) {
  const TEXT = 'mmmmmmmmmmlli';
  ctx.font = '72px monospace';
  const base = ctx.measureText(TEXT).width;
  const found = [];
  for (const f of CANDIDATES) {
    ctx.font = `72px "${f}", monospace`;
    if (ctx.measureText(TEXT).width !== base) { found.push(f); }
  }
  return found;
}

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log('  PASS  ' + name); }
  else { console.log('  FAIL  ' + name + (detail ? ' -> ' + detail : '')); failures++; }
}

console.log('=== 1. Sin shim (host Linux): qué ve un detector ===');
{
  const ctx = new FakeCtx();
  const found = enumerateFonts(ctx);
  console.log('  detectadas:', found.join(', '));
  check('el host expone fuentes de Linux', found.includes('DejaVu Sans'));
  check('el host NO expone Segoe UI', !found.includes('Segoe UI'));
}

console.log('\n=== 2. Con shim, perfil Windows ===');
{
  const sandbox = runShim({
    seed: 12345,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
    platform: 'Win32', vendor: 'Google Inc.',
    screenWidth: 1920, screenHeight: 1080, devicePixelRatio: 1,
    hardwareConcurrency: 8, deviceMemory: 8, maxTouchPoints: 0,
    language: 'es-ES', timezone: 'Europe/Madrid', tzOffsetMinutes: 60,
    fonts: PROFILE_FONTS,
  });
  const ctx = new FakeCtx();
  check('measureText quedo parcheado', ctx.measureText !== origMeasure, 'sigue siendo el original');
  check('Function.prototype.toString sigue enmascarado',
    FakeCtx.prototype.measureText.toString().includes('[native code]'),
    FakeCtx.prototype.measureText.toString().slice(0, 60));

  const found = enumerateFonts(ctx);
  console.log('  detectadas:', found.join(', '));
  // Sólo las que el host puede medir de verdad (alias aplicados). El shim no
  // puede fabricar métricas para una fuente ausente en el host.
  const MEASURABLE = ['Arial', 'Times New Roman', 'Georgia', 'Tahoma'];
  for (const f of MEASURABLE) {
    check('expone la fuente del perfil: ' + f, found.includes(f));
  }
  for (const f of ['DejaVu Sans', 'Noto Sans', 'Ubuntu', 'Lato', 'Liberation Sans']) {
    check('OCULTA la fuente extra del host: ' + f, !found.includes(f), 'se leakeo ' + f);
  }
  for (const f of ['Papyrus', 'Comic Papyrus', 'Wingdings', 'Inter', 'Roboto']) {
    check('no inventa una fuente ausente: ' + f, !found.includes(f), 'se invento ' + f);
  }
}

console.log('\n=== 3. measureText no rompe mediciones legitimas ===');
{
  const sandbox = runShim({ seed: 1, language: 'es-ES', timezone: 'Europe/Madrid', fonts: PROFILE_FONTS });
  const ctx = new FakeCtx();
  ctx.font = '16px Arial';
  const a = ctx.measureText('Hola');
  check('devuelve un objeto con width numerico', typeof a.width === 'number' && a.width > 0);
  // Mismo texto, mismo tamaño: debe ser estable (idempotente).
  const b = ctx.measureText('Hola');
  check('es estable entre llamadas', a.width === b.width, `${a.width} vs ${b.width}`);
  // Cambiar el font y volver debe restaurar el original.
  ctx.font = '16px Arial';
  const c = ctx.measureText('Hola');
  check('restaura ctx.font tras medir', ctx.font === '16px Arial', 'quedo en: ' + ctx.font);
}

console.log('\n=== 4. Idiomas y timezone ===');
{
  const sandbox = runShim({ seed: 1, language: 'es-ES', timezone: 'Asia/Tokyo', fonts: PROFILE_FONTS });
  const tz = sandbox.Intl.DateTimeFormat().resolvedOptions().timeZone;
  check('Intl reporta el timezone del perfil', tz === 'Asia/Tokyo', 'obtenido: ' + tz);
}

console.log('\n=== 5. Huella de audio ===');
{
  const CFG = { seed: 4242, language: 'es-ES', timezone: 'Europe/Madrid', fonts: PROFILE_FONTS };

  // Un detector real hashea los BYTES del Float32Array, no el valor redondeado.
  // El dither mueve ~1 ULP, así que hay que mirar la representación IEEE754:
  // con Math.round(v*1e9) los dos perfiles colapsarían al mismo entero.
  const bitsOf = (arr) => new Uint32Array(arr.buffer, arr.byteOffset, arr.length);
  const hashBits = (arr) => {
    const u = bitsOf(arr);
    let h = 7;
    for (let i = 0; i < u.length; i++) { h = (Math.imul(h, 31) + u[i]) | 0; }
    return h;
  };
  const hostArr = () => new Float32Array(128).fill(HOST_SIGNAL);

  const sA = runShim(CFG);
  const sB = runShim({ ...CFG, seed: 999999 });

  const render = (sandbox) => {
    const ctx = new sandbox.OfflineAudioContext(1, 128);
    return ctx.startRendering().then((buf) => buf.getChannelData(0));
  };

  render(sA).then(async (rawA) => {
    const rawB = await render(sB);

    check('startRendering quedo parcheado',
      sA.OfflineAudioContext.prototype.startRendering.toString().includes('[native code]'),
      sA.OfflineAudioContext.prototype.startRendering.toString().slice(0, 60));

    const hA = hashBits(rawA);
    const hB = hashBits(rawB);
    const hHost = hashBits(hostArr());

    check('el perfil A no coincide con la senal del host', hA !== hHost, 'hash host: ' + hHost);
    check('el perfil A y el B difieren (dither por perfil)', hA !== hB,
      'A=' + hA + ' B=' + hB);

    check('el perfil A es ESTABLE entre dos renders', hashBits(await render(sA)) === hA);
    check('el perfil B es ESTABLE entre dos renders', hashBits(await render(sB)) === hB);

    // Estabilidad entre "sesiones": mismo perfil, grafo identico, mismo hash.
    const again = await render(sA);
    check('mismo perfil, misma huella entre sesiones', hashBits(again) === hA);

    // La estructura se conserva: una senal plana delata el parche.
    const distinct = new Set(Array.from(bitsOf(rawA)));
    check('la senal conserva estructura (no es plana)', distinct.size > 4,
      'valores distintos: ' + distinct.size);
    const maxDelta = Math.max(...Array.from(rawA).map((v) => Math.abs(v - HOST_SIGNAL)));
    check('la perturbacion es ~1 ULP (inaudible)',
      maxDelta > 0 && maxDelta < 1e-6, 'delta maximo: ' + maxDelta);

    // b) AnalyserNode
    const an = new sA.AnalyserNode();
    const f1 = new Float32Array(64);
    an.getFloatFrequencyData(f1);
    const f2 = new Float32Array(64);
    an.getFloatFrequencyData(f2);
    check('getFloatFrequencyData difiere del host', hashBits(f1) !== hashBits(new Float32Array(64).fill(HOST_SIGNAL)));
    check('getFloatFrequencyData es ESTABLE', hashBits(f1) === hashBits(f2));
    const u = new Uint8Array(64);
    an.getByteFrequencyData(u);
    check('getByteFrequencyData sigue en rango 0..255',
      Array.from(u).every((v) => v >= 0 && v <= 255));
    const td1 = new Float32Array(64);
    an.getFloatTimeDomainData(td1);
    const td2 = new Float32Array(64);
    an.getFloatTimeDomainData(td2);
    check('getFloatTimeDomainData difiere del host', hashBits(td1) !== hashBits(new Float32Array(64).fill(HOST_SIGNAL)));
    check('getFloatTimeDomainData es ESTABLE', hashBits(td1) === hashBits(td2));

    // c) AudioBuffer (decodeAudioData / salida de un AudioWorklet)
    const buf = new sA.AudioBuffer(1, 64);
    const ch1 = buf.getChannelData(0);
    const ch2 = buf.getChannelData(0);
    check('getChannelData difiere del host', hashBits(ch1) !== hashBits(new Float32Array(64).fill(HOST_SIGNAL)));
    check('getChannelData es ESTABLE (mismo array)', hashBits(ch1) === hashBits(ch2));
    const dest1 = new Float32Array(64);
    buf.copyFromChannel(dest1, 0);
    const dest2 = new Float32Array(64);
    buf.copyFromChannel(dest2, 0);
    check('copyFromChannel es ESTABLE', hashBits(dest1) === hashBits(dest2));
    check('copyFromChannel coincide con getChannelData', hashBits(dest1) === hashBits(ch1));

    console.log('\n' + (failures === 0
      ? 'TODAS LAS COMPROBACIONES PASARON'
      : failures + ' COMPROBACIONES FALLARON'));
    process.exit(failures === 0 ? 0 : 1);
  }).catch((e) => {
    console.log('  ERROR ejecutando las pruebas de audio:', (e && e.stack) || e);
    process.exit(1);
  });
}
