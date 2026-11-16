(function () {
    'use strict';
    var C = __CONFIG_JSON__;
    if (!C || typeof C !== 'object') { return; }

    // La identidad solo se publica para la página de diagnóstico
    // (tools/fingerprint-lab), con KRAKENGES_FP_LAB=1. Antes se publicaba siempre
    // en window.__krakenges, enumerable y no borrable: cualquier web podía leer la
    // receta entera, con el nombre del producto incluido.
    if (C.debugLab === true) {
        try {
            Object.defineProperty(window, '__krakenges', {
                value: JSON.parse(JSON.stringify(C)),
                writable: false,
                configurable: true,
                enumerable: false
            });
        } catch (e) {}
    }
    var st = (C.seed || 1) >>> 0;
    function rand() { st = (st * 1664525 + 1013904223) >>> 0; return st / 4294967296; }
    var pSalt = st;
    try {
        (function () {
            var h = 0x811c9dc5, i, s = String(location.hostname || '');
            for (i = 0; i < s.length; i++) { h = ((h ^ s.charCodeAt(i)) * 0x01000193) >>> 0; }
            pSalt = (st ^ h) >>> 0;
        })();
    } catch (e) {}
    function perRand() { pSalt = (pSalt * 1664525 + 1013904223) >>> 0; return pSalt / 4294967296; }

    var origFnToString = Function.prototype.toString;
    var nativeSet = typeof WeakSet !== 'undefined' ? new WeakSet() : null;
    // Devuelve una función que se comporta como una nativa. Una `function` normal
    // tiene .prototype y se puede usar con `new`; una nativa no tiene ninguna de
    // las dos cosas, y Pixelscan lo comprueba. Se envuelve en un Proxy sobre una
    // "cáscara" creada como método (sin prototype, no constructora) con el
    // name y el length correctos; el Proxy solo intercepta la llamada.
    function markNative(fn, name) {
        if (!fn) { return fn; }
        var out = fn;
        try {
            var holder = {};
            holder = { [name]() {} };
            var shell = holder[name];
            Object.defineProperty(shell, 'length', { value: fn.length, configurable: true });
            out = new Proxy(shell, {
                apply: function (target, thisArg, args) { return fn.apply(thisArg, args); }
            });
        } catch (e) {
            try { Object.defineProperty(fn, 'name', { value: name, configurable: true }); } catch (e2) {}
        }
        if (nativeSet) { nativeSet.add(out); }
        return out;
    }
    if (nativeSet) {
        try {
            // Expresión con nombre: `toString.toString()` debe decir
            // "function toString() { [native code] }"; con `var newToString =
            // function` delataba el nombre "newToString".
            var newToString = function toString() {
                if (nativeSet.has(this)) {
                    return 'function ' + (this.name || '') + '() { [native code] }';
                }
                return origFnToString.apply(this, arguments);
            };
            newToString = markNative(newToString, 'toString');
            Object.defineProperty(Function.prototype, 'toString', {
                value: newToString,
                writable: true,
                enumerable: false, // In native V8, Function.prototype.toString is NEVER enumerable
                configurable: true
            });
        } catch (e) {}
    }

    var navTargets = [];
    if (typeof Navigator !== 'undefined' && Navigator.prototype) { navTargets.push(Navigator.prototype); }
    if (typeof WorkerNavigator !== 'undefined' && WorkerNavigator.prototype) { navTargets.push(WorkerNavigator.prototype); }
    // Solo prototipos. Antes también se definía sobre la instancia `navigator`:
    // en Chrome real Object.getOwnPropertyNames(navigator) es [] y con el shim
    // devolvía userAgent, platform, language... (Pixelscan: "Masking detected").

    function defNav(p, v) {
        // Si el valor real ya es el deseado, no se toca: redefinirlo no cambia
        // nada visible y deja un getter que no es el original.
        try {
            var real = navigator[p];
            if (real === v || (Array.isArray(v) && real && JSON.stringify(Array.prototype.slice.call(real)) === JSON.stringify(v))) { return; }
        } catch (e) {}
        // navigator.languages devuelve siempre el mismo array congelado.
        if (Array.isArray(v) && Object.freeze) { v = Object.freeze(v.slice()); }
        navTargets.forEach(function (target) {
            try {
                Object.defineProperty(target, p, {
                    configurable: true,
                    enumerable: true,
                    get: markNative(function () {
                        var ok = false;
                        try {
                            if (typeof Navigator !== 'undefined' && this instanceof Navigator) { ok = true; }
                            if (typeof WorkerNavigator !== 'undefined' && this instanceof WorkerNavigator) { ok = true; }
                            if (this === navigator) { ok = true; }
                        } catch (e) {}
                        if (!ok) {
                            throw new TypeError("Illegal invocation");
                        }
                        return v;
                    }, 'get ' + p)
                });
            } catch (e) {}
        });
    }

    // Hardware Concurrency & Device Memory (con guardia de invocación nativa y soporte Worker)
    if (C.hardwareConcurrency) { try { defNav('hardwareConcurrency', C.hardwareConcurrency); } catch (e) {} }
    if (C.deviceMemory) { try { defNav('deviceMemory', C.deviceMemory); } catch (e) {} }
    if (C.maxTouchPoints !== undefined && C.maxTouchPoints !== null) { try { defNav('maxTouchPoints', C.maxTouchPoints); } catch (e) {} }
    if (C.platform) { try { defNav('platform', C.platform); } catch (e) {} }
    if (C.userAgent) { try { defNav('userAgent', C.userAgent); } catch (e) {} }

    // Idioma del perfil.
    //
    // Antes no se parcheaba: en un worker la sesión CDP no recibe
    // Emulation.setLocaleOverride, así que `navigator.language` devolvía el
    // idioma real de la interfaz del navegador mientras la página announces el
    // del perfil. Ese contraste entre la página y un SharedWorker del mismo
    // perfil delata la emulación con dos líneas de código.
    if (C.language) {
        try { defNav('language', C.language); } catch (e) {}
        try {
            var _base = String(C.language).split('-')[0];
            defNav('languages', _base && _base !== C.language ? [C.language, _base] : [C.language]);
        } catch (e) {}
    }

    // Timezone reported por Intl.
    //
    // Mismo motivo: en workers no se aplica Emulation.setTimezoneOverride, y
    // `Intl.DateTimeFormat().resolvedOptions().timeZone` es una de las tres
    // señales que se cruzan para validar la coherencia geográfica (junto al
    // idioma y al país de la IP).
    //
    // Limitación conocida: esto corrige lo que se LEE (resolvedOptions), que es
    // lo que miden los detectores. El formateo interno de Intl sigue usando el
    // reloj del sistema, así que las horas renderizadas no se desplazan. Para
    // desplazar también la forma habría que interceptar el formateo, con el
    // riesgo de romper el formato de fechas de los sitios.
    if (C.timezone && typeof Intl !== 'undefined' && Intl.DateTimeFormat) {
        try {
            var _origResolved = Intl.DateTimeFormat.prototype.resolvedOptions;
            var _patchedResolved = function () {
                var out = _origResolved.apply(this, arguments);
                try { out.timeZone = C.timezone; } catch (e) {}
                return out;
            };
            try {
                Object.defineProperty(_patchedResolved, 'name', { value: 'resolvedOptions', configurable: true });
                Object.defineProperty(_patchedResolved, 'length', { value: 0, configurable: true });
            } catch (e) {}
            Intl.DateTimeFormat.prototype.resolvedOptions = markNative(_patchedResolved, 'resolvedOptions');
        } catch (e) {}
    }

    // ---------------------------------------------------------------------
    // Enumeración de fuentes
    // ---------------------------------------------------------------------
    //
    // La técnica estándar para enumerar fuentes instaladas en un navegador es
    // medir un texto en canvas con `"Familia", monospace` y comparar el ancho
    // con el de `monospace` a secas: si difiere, la familia existe.
    //
    // `C.fonts` (la lista de fuentes del sistema que el perfil dice emular) se
    // pasaba al shim pero no se usaba para nada, así que un perfil "Windows 11"
    // ejecutado sobre un host Linux respondía con las fuentes reales de Linux.
    // Las tres señales que se cruzan (idioma, timezone, fuentes) quedaban rotas
    // a la vez.
    //
    // Se simula el comportamiento real del navegador: si la primera familia
    // pedida no está en la lista declarada, se devuelve la medida con la familia
    // genérica, que es exactamente lo que hace el motor cuando no encuentra la
    // fuente. Un perfil sólo expone las fuentes que dice exponer.
    //
    // Alcance real de esta técnica (verificado en tests/shim_behavior.test.cjs):
    // el shim puede OCULTAR las fuentes que el host tiene de más, pero no puede
    // fabricar métricas para una fuente que el host no tiene. Por eso
    // `ensure_fontconfig_aliases()` en launcher.rs es imprescindible: crea los
    // alias de las familias "Microsoft" para que Arial, Times New Roman, etc.
    // existan en el host con métricas compatibles (Liberation/Carlito/Caladea).
    // Sin esos alias, un perfil Windows no podría exponer nada en absoluto.
    //
    // Nota de riesgo: `measureText` sólo lo usan las mediciones de JS. El layout
    // del DOM no pasa por aquí, así que el texto de la página no se ve afectado.
    var declaredFonts = {};
    (function () {
        var list = C.fonts;
        if (list && list.length) {
            for (var i = 0; i < list.length; i++) {
                declaredFonts[String(list[i]).toLowerCase()] = true;
            }
        }
    })();

    var GENERIC_FAMILIES = ['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy',
        'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded',
        'math', 'emoji', 'fangsong'];

    function isGeneric(f) {
        return GENERIC_FAMILIES.indexOf(String(f).toLowerCase().replace(/["']/g, '')) >= 0;
    }

    /// Separa `"italic 700 12.5px \"Foo Bar\", Arial, sans-serif"` en su parte de
    /// tamaño y su lista de familias, respetando las comillas.
    function splitFontSpec(spec) {
        var s = String(spec || '');
        var m = /([\d.]+)px\s*([\s\S]*)$/.exec(s);
        if (!m) { return null; }
        var rest = m[2], fams = [], cur = '', inQ = false;
        for (var i = 0; i < rest.length; i++) {
            var ch = rest.charAt(i);
            if (ch === '"' || ch === "'") { inQ = !inQ; cur += ch; continue; }
            if (ch === ',' && !inQ) { if (cur.trim()) { fams.push(cur.trim()); } cur = ''; continue; }
            cur += ch;
        }
        if (cur.trim()) { fams.push(cur.trim()); }
        if (!fams.length) { return null; }
        return { prefix: s.slice(0, m.index), size: m[1] + 'px', families: fams };
    }

    function stripQuotes(f) {
        return String(f).replace(/^["']/, '').replace(/["']$/, '').trim();
    }

    /// Devuelve la familia DECLARADA que el navegador usaría, o null si el
    /// motor caería a una genérica.
    ///
    /// El motor recorre la lista en orden y se queda con la primera disponible.
    /// Para el perfil, "disponible" significa estar en `C.fonts`: si la familia
    /// pedida no está declarada, el resultado es el mismo que si no existiera,
    /// y eso es lo que hay que reproducir.
    function resolveFamily(families) {
        for (var i = 0; i < families.length; i++) {
            var f = stripQuotes(families[i]);
            if (isGeneric(f)) { return null; }
            if (declaredFonts[f.toLowerCase()]) { return f; }
        }
        return null;
    }

    /// Familia genérica con la que hay que medir cuando la pedida no existe.
    function genericFallback(families) {
        for (var i = families.length - 1; i >= 0; i--) {
            var f = stripQuotes(families[i]);
            if (isGeneric(f)) { return f; }
        }
        return 'sans-serif';
    }

    function patchMeasureText(Ctor) {
        if (!Ctor || !Ctor.prototype || !Ctor.prototype.measureText) { return; }
        var proto = Ctor.prototype;
        var orig = proto.measureText;
        var wrapper = function (text) {
            if (!(this instanceof Ctor)) {
                throw new TypeError("Illegal invocation");
            }
            var spec = null;
            try { spec = splitFontSpec(this.font); } catch (e) {}
            if (!spec) { return orig.apply(this, arguments); }

            if (resolveFamily(spec.families) !== null) {
                // La familia existe en la identidad: la medida real es correcta.
                return orig.apply(this, arguments);
            }

            // Ninguna familia pedida está declarada: el motor caería a la
            // genérica. Se mide con ella para reproducir su anchura exacta, que
            // es la misma que obtiene quien mide sólo con la genérica.
            try {
                var prev = this.font;
                this.font = spec.prefix + spec.size + ' ' + genericFallback(spec.families);
                var out = orig.call(this, text);
                this.font = prev;
                return out;
            } catch (e) {
                return orig.apply(this, arguments);
            }
        };
        try {
            Object.defineProperty(wrapper, 'name', { value: 'measureText', configurable: true });
            Object.defineProperty(wrapper, 'length', { value: 1, configurable: true });
        } catch (e) {}
        proto.measureText = markNative(wrapper, 'measureText');
    }

    if (typeof CanvasRenderingContext2D !== 'undefined') {
        patchMeasureText(CanvasRenderingContext2D);
    }
    if (typeof OffscreenCanvasRenderingContext2D !== 'undefined') {
        patchMeasureText(OffscreenCanvasRenderingContext2D);
    }

    // `document.fonts.check('12px "Familia"')` es la otra mitad de la
    // enumeración: sin esto, el sitio ve "false" para las fuentes que el perfil
    // dice tener y "true" para las de verdad.
    if (typeof document !== 'undefined' && document.fonts && document.fonts.check) {
        try {
            var origCheck = document.fonts.check;
            var checkProto = Object.getPrototypeOf(document.fonts);
            var checkWrapper = function (font, text) {
                var spec = null;
                try { spec = splitFontSpec(font); } catch (e) {}
                if (!spec) { return origCheck.apply(this, arguments); }
                // Se comprueba solo la primera familia, que es la que decide.
                return resolveFamily([spec.families[0]]) !== null;
            };
            try {
                Object.defineProperty(checkWrapper, 'name', { value: 'check', configurable: true });
                Object.defineProperty(checkWrapper, 'length', { value: 2, configurable: true });
            } catch (e) {}
            var patchedCheck = markNative(checkWrapper, 'check');
            if (checkProto) {
                checkProto.check = patchedCheck;
            }
        } catch (e) {}
    }

    // Canvas Noise: se aplica ÚNICAMENTE en lienzos mayores a 32x32.
    // Los lienzos pequeños (<= 32px) utilizados para pruebas de fuentes y emojis de Google Botguard
    // quedan 100% auténticos y sin ruido para evitar detección de anomalías.
    var noisedSet = typeof WeakSet !== 'undefined' ? new WeakSet() : null;
    function noiseImage(img) {
        if (!img || !img.data) { return img; }
        if (noisedSet && noisedSet.has(img)) { return img; }
        try {
            var d = img.data, i, delta, ch;
            for (i = 0; i < d.length; i += 32) {
                if (perRand() < 0.005) {
                    ch = (Math.floor(perRand() * 4)) % 3;
                    delta = perRand() < 0.5 ? -1 : 1;
                    d[i + ch] = Math.min(255, Math.max(0, d[i + ch] + delta));
                }
            }
            if (noisedSet) { noisedSet.add(img); }
        } catch (e) {}
        return img;
    }

    // Hook HTMLCanvasElement toDataURL & toBlob
    if (typeof HTMLCanvasElement !== 'undefined') {
        try {
            ['toDataURL', 'toBlob'].forEach(function (m) {
                var orig = HTMLCanvasElement.prototype[m];
                if (!orig) { return; }
                HTMLCanvasElement.prototype[m] = markNative(function () {
                    if (!(this instanceof HTMLCanvasElement)) {
                        throw new TypeError("Illegal invocation");
                    }
                    if (this.width > 32 && this.height > 32 && this.width <= 4096 && this.height <= 4096) {
                        try {
                            var off = document.createElement('canvas');
                            off.width = this.width;
                            off.height = this.height;
                            var offCtx = off.getContext('2d');
                            if (offCtx) {
                                offCtx.drawImage(this, 0, 0);
                                var imgData = offCtx.getImageData(0, 0, off.width, off.height);
                                offCtx.putImageData(noiseImage(imgData), 0, 0);
                                return orig.apply(off, arguments);
                            }
                        } catch (e) {}
                    }
                    return orig.apply(this, arguments);
                }, m);
            });
        } catch (e) {}
    }

    // Hook getImageData en CanvasRenderingContext2D y OffscreenCanvasRenderingContext2D
    function hookGetImageData(proto) {
        if (!proto || !proto.getImageData) { return; }
        var orig = proto.getImageData;
        proto.getImageData = markNative(function (sx, sy, sw, sh) {
            var res = orig.apply(this, arguments);
            var w = this.canvas ? this.canvas.width : sw;
            var h = this.canvas ? this.canvas.height : sh;
            if (w > 32 && h > 32 && w <= 4096 && h <= 4096) {
                noiseImage(res);
            }
            return res;
        }, 'getImageData');
    }

    if (typeof CanvasRenderingContext2D !== 'undefined') {
        try { hookGetImageData(CanvasRenderingContext2D.prototype); } catch (e) {}
    }
    if (typeof OffscreenCanvasRenderingContext2D !== 'undefined') {
        try { hookGetImageData(OffscreenCanvasRenderingContext2D.prototype); } catch (e) {}
    }

    // Hook OffscreenCanvas.prototype.convertToBlob
    if (typeof OffscreenCanvas !== 'undefined' && OffscreenCanvas.prototype.convertToBlob) {
        try {
            var origConvertToBlob = OffscreenCanvas.prototype.convertToBlob;
            OffscreenCanvas.prototype.convertToBlob = markNative(function (opts) {
                if (!(this instanceof OffscreenCanvas)) {
                    return Promise.reject(new TypeError("Illegal invocation"));
                }
                if (this.width > 32 && this.height > 32 && this.width <= 4096 && this.height <= 4096) {
                    try {
                        var clone = new OffscreenCanvas(this.width, this.height);
                        var cloneCtx = clone.getContext('2d');
                        if (cloneCtx) {
                            cloneCtx.drawImage(this, 0, 0);
                            var data = cloneCtx.getImageData(0, 0, clone.width, clone.height);
                            cloneCtx.putImageData(noiseImage(data), 0, 0);
                            return origConvertToBlob.apply(clone, arguments);
                        }
                    } catch (e) {}
                }
                return origConvertToBlob.apply(clone, arguments);
            }, 'convertToBlob');
        } catch (e) {}
    }

    // WebGL: vendor y renderer NO se falsean. Los Web Workers (OffscreenCanvas)
    // no reciben el shim y devolvían la GPU real (Mesa UHD 600) frente a la
    // "RTX 2070" de la página; además VENDOR/RENDERER (0x1F00/0x1F01) devolvían
    // la GPU cuando en Chrome real son "WebKit" / "WebKit WebGL". Una GPU
    // anunciada que no es la que renderiza se delata igual por rendimiento y
    // por parámetros. Pixelscan: "Masking detected".

    // ---------------------------------------------------------------------
    // Huella de audio
    // ---------------------------------------------------------------------
    //
    // La señal de audio es la huella que más directamente delata el hardware:
    // depende de la implementación de coma flotante de la pila de audio del
    // SO. Dos perfiles en la MISMA máquina comparten el mismo hash de audio, lo
    // que permite a un servicio agrupar cuentas aunque todo lo demás rote.
    //
    // Estrategia: NO se sustituyen los datos por valores inventados (eso es lo
    // que hacía el PoC en native-injector/poc/fingerprint.js, y produce una
    // señal plana que no se parece a audio real). Se deja que el motor renderice
    // de verdad y se perturba el último bit de cada muestra con un dither
    // determinista por perfil.
    //
    // Por qué funciona:
    //   - La estructura se conserva intacta, así que el resultado sigue siendo
    //     indistinguible de una medición real (un array plano delata el parche).
    //   - La magnitud (±1 ULP en float32) es inaudible y no altera el audio que
    //     reproduce la página.
    //   - Al cambiar el último bit, el hash cambia por completo: cada perfil
    //     tiene su propia huella de audio, estable entre sesiones y distinta
    //     entre perfiles del mismo equipo.
    //
    // Superficie cubierta:
    //   1. OfflineAudioContext.startRendering()  <- la que usa FingerprintJS y
    //      la mayoría de detectores modernos. Es la importante.
    //   2. AnalyserNode getFloat/getByteFrequencyData y getFloatTimeDomainData
    //      <- detectores antiguos, y la lectura desde un AudioWorklet.
    //   3. AudioBuffer getChannelData / copyFromChannel <- cubre los buffers que
    //      no pasan por startRendering (decodeAudioData, salidas de worklet).
    var audioDithered = typeof WeakSet !== 'undefined' ? new WeakSet() : null;
    var audioSeed = (C.seed || 1) >>> 0;

    /// Ruido determinista para la posición `i` del canal `ch`.
    ///
    /// Es una FUNCIÓN PURA de (seed del perfil, canal, índice). No consume un
    /// contador global, y esto es deliberado: si el ruido advanced con las
    /// llamadas, dos renders idénticos de la misma sesión producirían hashes
    /// distintos. Un navegador real devuelve SIEMPRE lo mismo para la misma
    /// entrada, así que esa inconsistencia es en sí misma una señal de
    /// automatización, y además haría que la huella de audio no fuese estable
    /// entre sesiones.
    function audioNoiseAt(ch, i) {
        var x = (audioSeed ^ Math.imul(i + 1, 0x9E3779B1) ^ Math.imul(ch + 1, 0x85EBCA6B)) >>> 0;
        x ^= x >>> 16; x = Math.imul(x, 0x85ebca6b) >>> 0;
        x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35) >>> 0;
        x ^= x >>> 16;
        return (x >>> 0) / 4294967296;
    }

    /// Perturba un Float32Array en ~1 ULP. Determinista por perfil.
    function ditherFloat32(arr, ch) {
        if (!arr || !arr.length) { return arr; }
        if (audioDithered && audioDithered.has(arr)) { return arr; }
        var c = ch || 0;
        try {
            for (var i = 0; i < arr.length; i++) {
                arr[i] = arr[i] + (audioNoiseAt(c, i) - 0.5) * 1e-7;
            }
            if (audioDithered) { audioDithered.add(arr); }
        } catch (e) {}
        return arr;
    }

    /// Dither de ±1 en un Uint8Array, respetando el rango.
    function ditherUint8(arr, ch) {
        if (!arr || !arr.length) { return arr; }
        if (audioDithered && audioDithered.has(arr)) { return arr; }
        var c = ch || 0;
        try {
            for (var i = 0; i < arr.length; i++) {
                arr[i] = Math.max(0, Math.min(255, arr[i] + (audioNoiseAt(c, i) < 0.5 ? 0 : 1)));
            }
            if (audioDithered) { audioDithered.add(arr); }
        } catch (e) {}
        return arr;
    }

    // 1. OfflineAudioContext: el motor renderiza, y luego se perturba el buffer.
    if (typeof OfflineAudioContext !== 'undefined' && OfflineAudioContext.prototype) {
        try {
            var origStart = OfflineAudioContext.prototype.startRendering;
            if (origStart) {
                OfflineAudioContext.prototype.startRendering = markNative(function () {
                    var ctx = this;
                    if (!(this instanceof OfflineAudioContext)) {
                        throw new TypeError("Illegal invocation");
                    }
                    var p = origStart.apply(this, arguments);
                    // El render es asíncrono: se perturba cuando resuelve.
                    return p.then(function (buffer) {
                        try {
                            if (buffer && buffer.length) {
                                for (var ch = 0; ch < buffer.numberOfChannels; ch++) {
                                    ditherFloat32(buffer.getChannelData(ch), ch);
                                }
                            }
                        } catch (e) {}
                        return buffer;
                    });
                }, 'startRendering');
            }
        } catch (e) {}
    }

    // 2. AnalyserNode: se parte de los datos reales y se dithera.
    if (typeof AnalyserNode !== 'undefined' && AnalyserNode.prototype) {
        try {
            [
                ['getFloatFrequencyData', ditherFloat32],
                ['getFloatTimeDomainData', ditherFloat32],
                ['getByteFrequencyData', ditherUint8]
            ].forEach(function (pair) {
                var name = pair[0], dither = pair[1];
                var orig = AnalyserNode.prototype[name];
                if (!orig) { return; }
                AnalyserNode.prototype[name] = markNative(function (out) {
                    if (!(this instanceof AnalyserNode)) {
                        throw new TypeError("Illegal invocation");
                    }
                    var r = orig.apply(this, arguments);
                    dither(out, 0);
                    return r;
                }, name);
            });
        } catch (e) {}
    }

    // 3. AudioBuffer: cubre los buffers que no vienen de startRendering
    //    (decodeAudioData y las salidas de un AudioWorklet).
    //
    // Ojo con el doble dither: `getChannelData` devuelve el array INTERNO, que
    // se perturba in situ. Si `copyFromChannel` perturbara su destino DESPUÉS de
    // copiar, aplicaría el ruido dos veces sobre los mismos datos. Por eso aquí
    // se perturba la fuente ANTES de copiar, y `ditherFloat32` ya es idempotente
    // gracias al WeakSet: si el canal se perturbó antes, no vuelve a tocarlo.
    if (typeof AudioBuffer !== 'undefined' && AudioBuffer.prototype) {
        try {
            var origGetCh = AudioBuffer.prototype.getChannelData;
            if (origGetCh) {
                AudioBuffer.prototype.getChannelData = markNative(function (ch) {
                    if (!(this instanceof AudioBuffer)) {
                        throw new TypeError("Illegal invocation");
                    }
                    return ditherFloat32(origGetCh.apply(this, arguments), ch);
                }, 'getChannelData');
            }
            var origCopy = AudioBuffer.prototype.copyFromChannel;
            if (origCopy) {
                AudioBuffer.prototype.copyFromChannel = markNative(function (dest, ch) {
                    if (!(this instanceof AudioBuffer)) {
                        throw new TypeError("Illegal invocation");
                    }
                    try {
                        ditherFloat32(origGetCh.call(this, ch), ch);
                    } catch (e) {}
                    return origCopy.apply(this, arguments);
                }, 'copyFromChannel');
            }
        } catch (e) {}
    }


    // Pantalla: no se falsea aquí. La emula el motor (Emulation.
    // setDeviceMetricsOverride en cdp.rs), que mantiene coherentes screen.* y
    // las media queries; falsearla en JS dejaba device-width con el valor real.

})();
