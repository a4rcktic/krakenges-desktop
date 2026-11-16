/* =============================================================================
 * Kraken Ges Fingerprint Lab — sondas de superficie de fingerprint
 * =============================================================================
 *
 * QUÉ ES
 *
 * Un detector de fingerprints que no intenta " pillarte". Intenta responder a
 * tres preguntas, que son las que importan cuando estás construyendo un antidetect:
 *
 *   1. ¿Qué ve un sitio de ti?           -> el valor OBSERVADO
 *   2. ¿Qué querías tú?                  -> el valor INTENCIONADO (window.__krakenges)
 *   3. ¿Coinciden?                        -> el VEREDICTO
 *
 * El veredicto tiene TRES salidas, y la tercera es la que hace útil la
 * herramienta:
 *
 *   coherente   lo controlas y coincide
 *   SE ESCAPA   lo inyectas, pero algo delata al motor real
 *   sin control no lo tocas: TLS, HTTP/2, versión real del navegador...
 *
 * La mayoría de checklists de "qué se puede falsificar" dan una lista estática
 * que envejece. Esto lo calcula en vivo.
 *
 * POR QUÉ ES AUTÓNOMO
 *
 * Se abre en cualquier navegador, sin servidor ni compilación. Eso permite
 * comparar el MISMO conjunto de sondas en:
 *   - Chrome normal de escritorio
 *   - una sesión de Kraken Ges en escritorio
 *   - una sesión de Kraken Ges en el teléfono   <- aquí es donde sale lo interesante
 *
 * La diferencia entre las tres tablas ES el informe.
 *
 * LO QUE NO PUEDE MEDIR (y lo dice, en vez de callarlo)
 *
 * Desde JavaScript no se ve la capa de red. Estas señales existen y no aparecen
 * en la tabla: necesitan medirse desde fuera.
 *
 *   - TLS / JA3 / JA4           lo ve el servidor en el handshake
 *   - HTTP/2 fingerprint        SETTINGS, orden de cabeceras, prioridades
 *   - Versión real del motor    un WebView no se disfraza de Chromium de escritorio
 *   - IP, pais, ASN             coherencia con timezone e idioma
 *
 * Para esas, lo que hace falta es una sonda externa (un endpoint que registre
 * el JA3 del cliente) y comparar su resultado con lo que el perfil declara.
 * Por eso la tabla las lista como 'externas' y no como 'ok'.
 * ========================================================================== */
(function (global) {
  'use strict';

  // ───────────────────────────────────────────────────────────────────────────
  // Utilidades
  // ───────────────────────────────────────────────────────────────────────────

  function safe(fn, fallback) {
    try {
      var v = fn();
      return v === undefined ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  function safeAsync(fn, fallback) {
    try {
      return Promise.resolve(fn()).catch(function () { return fallback; });
    } catch (e) {
      return Promise.resolve(fallback);
    }
  }

  /**
   * Hash corto y estable de un valor largo.
   *
   * Antes el canvas devolvía los 230.400 bytes del buffer separados por comas,
   * que no son un problema del navegador sino del informe: ilegible, y con los
   * primeros píxeles a cero (el fondo transparente) que parecen un fallo cuando
   * no lo son. Para comparar dos perfiles solo importa si son iguales o no.
   */
  function hash(valor) {
    var s = String(valor), h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    return 'fnv1a:' + h.toString(16).padStart(8, '0');
  }

  function norm(v) {
    if (v === null) return 'null';
    if (v === undefined) return 'undefined';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    try { return JSON.stringify(v); } catch (e) { return String(v); }
  }

  function eq(a, b) {
    if (a === null || a === undefined || b === null || b === undefined) return null;
    if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-6;
    return norm(a) === norm(b);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Lectores de superficie. Cada uno devuelve un valor plano y comparable.
  // ───────────────────────────────────────────────────────────────────────────

  var LECTORES = {

    // ---- Identidad del motor -------------------------------------------------
    userAgent: function () { return navigator.userAgent; },
    appVersion: function () { return navigator.appVersion; },
    platform: function () { return navigator.platform; },
    vendor: function () { return navigator.vendor; },
    product: function () { return navigator.product; },
    productSub: function () { return navigator.productSub; },

    // ---- Client Hints -------------------------------------------------------
    //
    // OJO: platformVersion, architecture, bitness, model y fullVersionList son
    // valores de ALTA ENTROPÍA. No están en `navigator.userAgentData` como
    // propiedades: hay que pedirlos con getHighEntropyValues(), que es
    // asíncrono.
    //
    // Leerlos del objeto directamente devolvía undefined y el informe lo
    // enseñaba como "null", que parece un dato del dispositivo cuando en
    // realidad era un fallo del laboratorio. Se vio en el Galaxy A12 real.
    chBrands: function () {
      var ua = navigator.userAgentData;
      return ua && ua.brands ? ua.brands.map(function (b) { return b.brand + '/' + b.version; }).join(', ') : null;
    },
    chMobile: function () {
      var ua = navigator.userAgentData;
      return ua ? !!ua.mobile : null;
    },
    chPlatform: function () { return navigator.userAgentData ? navigator.userAgentData.platform : null; },

    chPlatformVersion: function () {
      var ua = navigator.userAgentData;
      if (!ua || !ua.getHighEntropyValues) return Promise.resolve(null);
      return safeAsync(function () { return ua.getHighEntropyValues(['platformVersion']); },
        null).then(function (v) { return v ? v.platformVersion : null; });
    },
    chArchitecture: function () {
      var ua = navigator.userAgentData;
      if (!ua || !ua.getHighEntropyValues) return Promise.resolve(null);
      return safeAsync(function () { return ua.getHighEntropyValues(['architecture']); },
        null).then(function (v) { return v ? v.architecture : null; });
    },
    chBitness: function () {
      var ua = navigator.userAgentData;
      if (!ua || !ua.getHighEntropyValues) return Promise.resolve(null);
      return safeAsync(function () { return ua.getHighEntropyValues(['bitness']); },
        null).then(function (v) { return v ? v.bitness : null; });
    },
    chModel: function () {
      var ua = navigator.userAgentData;
      if (!ua || !ua.getHighEntropyValues) return Promise.resolve(null);
      return safeAsync(function () { return ua.getHighEntropyValues(['model']); },
        null).then(function (v) { return v ? v.model : null; });
    },
    chFullVersionList: function () {
      var ua = navigator.userAgentData;
      if (!ua || !ua.getHighEntropyValues) return Promise.resolve(null);
      return safeAsync(function () { return ua.getHighEntropyValues(['fullVersionList']); },
        null).then(function (v) {
          return v && v.fullVersionList
            ? v.fullVersionList.map(function (b) { return b.brand + '/' + b.version; }).join(', ')
            : null;
        });
    },
    /** Pide los cinco de golpe: una sola llamada, que es como lo haria un sitio. */
    chAltaEntropia: function () {
      var ua = navigator.userAgentData;
      if (!ua || !ua.getHighEntropyValues) return Promise.resolve(null);
      return safeAsync(function () {
        return ua.getHighEntropyValues(['platformVersion', 'architecture', 'bitness', 'model']);
      }, null).then(function (v) {
        if (!v) return null;
        return 'platformVersion=' + JSON.stringify(v.platformVersion) +
               ' architecture=' + JSON.stringify(v.architecture) +
               ' bitness=' + JSON.stringify(v.bitness) +
               ' model=' + JSON.stringify(v.model);
      });
    },

    // ---- Hardware -----------------------------------------------------------
    cores: function () { return navigator.hardwareConcurrency; },
    deviceMemory: function () { return navigator.deviceMemory; },
    maxTouchPoints: function () { return navigator.maxTouchPoints; },

    // ---- Pantalla -----------------------------------------------------------
    screenWidth: function () { return screen.width; },
    screenHeight: function () { return screen.height; },
    availWidth: function () { return screen.availWidth; },
    availHeight: function () { return screen.availHeight; },
    colorDepth: function () { return screen.colorDepth; },
    pixelDepth: function () { return screen.pixelDepth; },
    devicePixelRatio: function () { return window.devicePixelRatio; },
    innerWidth: function () { return window.innerWidth; },
    innerHeight: function () { return window.innerHeight; },
    outerWidth: function () { return window.outerWidth; },
    outerHeight: function () { return window.outerHeight; },

    // ---- Locale y zona horaria ---------------------------------------------
    language: function () { return navigator.language; },
    languages: function () { return navigator.languages ? navigator.languages.join(', ') : null; },
    timezone: function () { return Intl.DateTimeFormat().resolvedOptions().timeZone; },
    timezoneOffset: function () { return new Date().getTimezoneOffset(); },
    // La coherencia entre el offset real y el nombre IANA es una de las
    // comprobaciones que mas encuentra CreepJS: 'Timezone spoofed'.
    timezoneOffsetReal: function () {
      // Desplazamiento del propio offset, que es donde se ve si parchean
      // getTimezoneOffset pero no Intl, o al reves.
      var d = new Date();
      return -d.getTimezoneOffset() / 60;
    },

    // ---- Gráficos -----------------------------------------------------------
    webglVendor: function () {
      var gl = document.createElement('canvas').getContext('webgl') ||
               document.createElement('canvas').getContext('experimental-webgl');
      if (!gl) return null;
      var e = gl.getExtension('WEBGL_debug_renderer_info');
      return e ? gl.getParameter(e.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
    },
    webglRenderer: function () {
      var gl = document.createElement('canvas').getContext('webgl') ||
               document.createElement('canvas').getContext('experimental-webgl');
      if (!gl) return null;
      var e = gl.getExtension('WEBGL_debug_renderer_info');
      return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    },
    webglVersion: function () {
      // Antes miraba el VENDOR y comparaba con 'WebGL', así que devolvía
      // 'noWebGL' en cualquier dispositivo real: el vendor es 'Google Inc.' y
      // la versión solo está en gl.VERSION. El laboratorio llegaba a decir que
      // no había WebGL en un móvil que tenía 25 extensiones.
      var gl = document.createElement('canvas').getContext('webgl') ||
               document.createElement('canvas').getContext('experimental-webgl');
      if (!gl) return 'sin contexto';
      return gl.getParameter(gl.VERSION) + ' | ' + gl.getParameter(gl.SHADING_LANGUAGE_VERSION);
    },
    webglExtensions: function () {
      var gl = document.createElement('canvas').getContext('webgl');
      if (!gl) return null;
      return gl.getSupportedExtensions() ? gl.getSupportedExtensions().length : null;
    },
    webgpu: function () { return navigator.gpu ? 'presente' : null; },

    // ---- Canvas: la señal más estable que hay -------------------------------
    // Se mide UNA vez y se reporta como hash. Dos perfiles del mismo usuario que
    // den el MISMO hash están enlazados aunque todo lo demás cambie: es la señal
    // que más sobrevive a los cambios.
    //
    // Se devuelve un hash y no el buffer porque comparar 230.400 bytes no lo hace
    // nadie, y porque los primeros píxeles son fondo transparente: un informe en
    // bruto empieza con una maraña de ceros que parece un fallo y no lo es.
    canvasHash: function () {
      var c = document.createElement('canvas');
      c.width = 240; c.height = 60;
      var x = c.getContext('2d');
      if (!x) return 'sin contexto 2d';
      x.textBaseline = 'top';
      x.font = '14px "Arial"';
      x.fillStyle = '#f60'; x.fillRect(125, 1, 62, 20);
      x.fillStyle = '#069'; x.fillText('Cwm fjordbank glyphs vext quiz 😃', 2, 15);
      x.fillStyle = 'rgba(102,204,0,0.7)'; x.fillText('Cwm fjordbank glyphs vext quiz 😃', 4, 17);
      try {
        var datos = x.getImageData(0, 0, 240, 60).data;
        var noTransparentes = 0;
        for (var i = 3; i < datos.length; i += 4) { if (datos[i] !== 0) noTransparentes++; }
        return hash(datos) + ' (pixeles pintados: ' + noTransparentes + ')';
      } catch (e) {
        return 'tainted';
      }
    },

    // ---- Permisos y capacidades --------------------------------------------
    // Se resuelven de verdad: antes se devolvía un array de promesas, que en el
    // informe salía como '[object Promise]' ocho veces y no decía nada.
    permissions: function () {
      if (!navigator.permissions || !navigator.permissions.query) return Promise.resolve(null);
      var pedir = ['geolocation', 'notifications', 'camera', 'microphone', 'clipboard-read'];
      return Promise.all(pedir.map(function (p) {
        return safeAsync(function () { return navigator.permissions.query({ name: p }); }, null)
          .then(function (r) { return r ? p + ':' + r.state : p + ':?'; });
      })).then(function (estados) { return estados.join(' · '); });
    },
    speechVoices: function () { return safe(function () { return speechSynthesis.getVoices().length; }, null); },
    mediaDevices: function () {
      return safe(function () {
        return navigator.mediaDevices.enumerateDevices().then(function (d) { return d.length; });
      }, null);
    },
    webRTC: function () { return typeof RTCPeerConnection !== 'undefined' ? 'presente' : null; },
    battery: function () { return typeof navigator.getBattery === 'function' ? 'presente' : null; },
    plugins: function () { return safe(function () { return navigator.plugins.length; }, null); },
    pdfViewer: function () {
      return safe(function () {
        for (var i = 0; i < navigator.plugins.length; i++) {
          if (/PDF/i.test(navigator.plugins[i].name)) return 'presente';
        }
        return 'ausente';
      }, null);
    },
    doNotTrack: function () { return navigator.doNotTrack; },
    cookieEnabled: function () { return navigator.cookieEnabled; },

    // ---- Red ----------------------------------------------------------------
    connection: function () {
      var c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      if (!c) return null;
      return c.effectiveType + '/' + c.downlink;
    },

    // ═════════════════════════════════════════════════════════════════════════
    // ¿ESTO ES UN WEBVIEW?
    //
    // En móvil no se puede ocultar que el renderizador es el WebView del
    // sistema. Estas señales existen, son públicas y se comprueban con dos
    // líneas de JavaScript. Están aquí para que se vea el techo, en vez de
    // descubrirlo cuando un cliente pregunte por qué lo detectan.
    //
    // A diferencia del resto, estas NO son "inconsistencias que arreglar": son
    // propiedades del contenedor. La pregunta útil no es "cómo las quito" sino
    // "cuántas páginas de la web lo hacen", y eso ya se responde con esto.
    // ═════════════════════════════════════════════════════════════════════════
    wvFlag: function () {
      // window.wv existe solo en Android WebView.
      return 'wv' in window;
    },
    cdcRastro: function () {
      // Android WebView deja artefactos $cdc_* en el document. Es la comprobación
      // más usada para detectar un WebView.
      var hallados = [];
      for (var k in document) {
        if (k.indexOf('$cdc_') === 0 || k.indexOf('$chrome_asyncScriptInfo') === 0) {
          hallados.push(k);
        }
      }
      return hallados.length ? hallados.join(', ') : (hallados.length === 0 ? 'ninguno' : '');
    },
    cdcEnWindow: function () {
      var hallados = [];
      for (var k in window) {
        if (k.indexOf('$cdc_') === 0) hallados.push(k);
      }
      return hallados.length ? hallados.join(', ') : 'ninguno';
    },
    puenteCapacitor: function () {
      // La app móvil se empaqueta con Capacitor. Un sitio puede detectarlo.
      var marcas = [];
      if (window.Capacitor) marcas.push('window.Capacitor');
      if (window.cordova) marcas.push('window.cordova');
      if (navigator.userAgent.indexOf('Capacitor') !== -1) marcas.push('UA:Capacitor');
      return marcas.length ? marcas.join(', ') : 'ninguno';
    },
    webviewEnUA: function () {
      // El UA de un WebView lleva marcas identificables. Retocarlas es facil;
      // que el motor NO las pongas por su cuenta es otra cosa, y eso lo decide
      // Android, no nosotros.
      var u = navigator.userAgent;
      var marcas = [];
      if (/\bwv\b/.test(u)) marcas.push('wv');
      if (/Version\/4\.0/.test(u)) marcas.push('Version/4.0');
      if (/; wv\)/.test(u)) marcas.push('; wv)');
      return marcas.length ? marcas.join(', ') : 'ninguna';
    },
    // Cuántas señales de WebView hay activas a la vez. Un detector real no
    // necesita las todas: le basta con dos.
    webviewSospechoso: function () {
      var n = 0;
      if ('wv' in window) n++;
      var cdc = false;
      for (var k in document) { if (k.indexOf('$cdc_') === 0) { cdc = true; break; } }
      if (cdc) n++;
      if (/Version\/4\.0/.test(navigator.userAgent)) n++;
      if (/\bwv\b/.test(navigator.userAgent)) n++;
      if (window.Capacitor) n++;
      return n;
    }
  };

  // Señales que existen, se ven desde fuera, y NO se pueden tocar desde JS.
  // Se listan aparte para que el informe no dé a entender que están controladas.
  var EXTERNAS = [
    { id: 'tls', label: 'TLS / JA3 / JA4', nota: 'El servidor lo ve en el handshake. Ningún JS lo cambia.' },
    { id: 'h2', label: 'HTTP/2 (SETTINGS, orden de cabeceras)', nota: 'Se ve en el tráfico. El motor Chromium lo define.' },
    { id: 'engine', label: 'Versión real del motor', nota: 'Un WebView no se disfraza de Chromium de escritorio. Se ve por feature detection.' },
    { id: 'ip', label: 'IP, país, ASN', nota: 'Debe concordar con timezone e idioma, o CreepJS marca incoherencia.' },
    { id: 'timing', label: 'Resolución temporal', nota: 'Canales laterales: Math.timing, temporizadores de alta precision, vida del objeto.' }
  ];

  // ───────────────────────────────────────────────────────────────────────────
  // Informe
  // ───────────────────────────────────────────────────────────────────────────

  function intention() {
    return safe(function () { return window.__krakenges || null; }, null);
  }

  function run() {
    var I = intention();
    var claves = Object.keys(LECTORES);

    // Las sondas de Client Hints y permisos son asíncronas, así que el informe
    // tiene que resolverlas antes de devolver nada. Antes se comprobaba "es una
    // promesa" y se escribía 'async', lo que hacía que el informe mostrara datos
    // a medio construir.
    return Promise.all(claves.map(function (k) {
      var obs;
      try {
        obs = LECTORES[k]();
      } catch (e) {
        obs = null;
      }
      if (obs && typeof obs.then === 'function') {
        return obs.then(function (v) { return [k, v]; },
                        function () { return [k, null]; });
      }
      return Promise.resolve([k, obs]);
    })).then(function (pares) {
      var filas = pares.map(function (p) {
        var k = p[0], obs = p[1];
        var queria = I ? I[k] : null;
        var hayIntension = I && queria !== null && queria !== undefined;
        var veredicto;
        if (!hayIntension) veredicto = I ? 'sin control' : 'observado';
        else if (eq(obs, queria)) veredicto = 'coherente';
        else veredicto = 'SE ESCAPA';
        return { clave: k, observado: obs, queria: hayIntension ? queria : null, veredicto: veredicto };
      });
      return { filas: filas, intencion: I, externas: EXTERNAS, webview: webview() };
    });
  }

  /**
   * Señales de WebView, con un veredicto PROPIO.
   *
   * No van en la tabla normal porque no se arreglan de la misma forma. Una
   * incoherencia se corrige inyectando el valor correcto; esto no: es una
   * propiedad del contenedor. Retocar el User-Agent no quita el `window.wv`, ni
   * los rastros `$cdc_` los pone Android, no nosotros.
   *
   * Por eso el veredicto no es "coherente" ni "SE ESCAPA" sino cuántos طرفos
   * hay encendidos. Un detector real no necesita los cinco: le bastan dos.
   */
  function webview() {
    var filas = [];
    ['wvFlag', 'cdcRastro', 'cdcEnWindow', 'webviewEnUA', 'puenteCapacitor', 'webviewSospechoso']
      .forEach(function (k) {
        var v = safe(function () { return LECTORES[k](); }, null);
        filas.push({ clave: k, observado: v });
      });
    return filas;
  }

  global.FingerprintLab = { run: run, LECTORES: LECTORES, EXTERNAS: EXTERNAS };

})(typeof window !== 'undefined' ? window : this);