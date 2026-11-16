#!/usr/bin/env node
/**
 * Aplica `brand.config.json` a todo lo que lleva el nombre, el dominio o las
 * rutas públicas de la marca:
 *
 *   - Cliente React: src/config/brand.generated.ts (nombre, textos, logos).
 *   - Tauri: productName, identifier, título de ventana y endpoint del updater.
 *   - Android: applicationId, namespace y strings.xml.
 *   - index.html: título y metadatos.
 *   - Rust: API base por defecto (se puede pisar con KRAKENGES_API_BASE al compilar)
 *     y src-tauri/src/brand.rs (nombre, slug e identificador: carpetas de datos,
 *     llavero del sistema, clase de ventana, User-Agent de descargas).
 *   - Cargo.toml: descripción y autor.
 *   - Backend: nombre, URL pública (CORS) y valores públicos de .env.example.
 *   - Instalador de Windows (installer/Setup.iss) y paquete de Arch
 *     (packaging/arch/PKGBUILD + app.desktop).
 *   - Claves públicas propias (licencias, updater, firma de Android): se
 *     escriben en license.rs, tauri.conf.json y MainActivity.java.
 *   - Página pública de descargas: site/downloads/index.html se genera desde
 *     index.template.html (nombre, prefijo de artefactos, versión, copyright).
 *
 * Uso:
 *   node tools/brand/apply.mjs
 *   node tools/brand/apply.mjs --check
 *   node tools/brand/apply.mjs --check --template
 *
 * `--check` no escribe nada: compara y sale con código 1 si falta aplicar algo.
 * Es el modo que usan CI y `npm run build`. `--template` permite validar un
 * paquete de código sin claves públicas: el comprador las genera al instalar.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const configPath = path.join(root, 'brand.config.json');
const checkOnly = process.argv.includes('--check');
const templateMode = process.argv.includes('--template');

if (!fs.existsSync(configPath)) {
  console.error(`No existe ${configPath}`);
  process.exit(1);
}

let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (error) {
  console.error(`brand.config.json no es JSON válido: ${error.message}`);
  process.exit(1);
}

const REQUIRED_STRINGS = [
  'appName',
  'slug',
  'shortName',
  'artifactPrefix',
  'appTitle',
  'appDescription',
  'tagline',
  'companyName',
  'copyright',
  'supportUrl',
  'publicBaseUrl',
  'apiBaseUrl',
  'updaterEndpoint',
  'downloadBaseUrl',
  'updaterDownloadBaseUrl',
  'releaseDate',
  'androidApplicationId',
  'tauriIdentifier',
  'windowTitle',
  'logoUrl',
  'logoSquare',
  'faviconUrl',
];

const URL_KEYS = [
  'supportUrl',
  'publicBaseUrl',
  'apiBaseUrl',
  'updaterEndpoint',
  'downloadBaseUrl',
  'updaterDownloadBaseUrl',
];

for (const key of REQUIRED_STRINGS) {
  if (typeof config[key] !== 'string' || !config[key].trim()) {
    console.error(`brand.config.json: falta "${key}" o está vacío.`);
    process.exit(1);
  }
}

for (const key of URL_KEYS) {
  try {
    new URL(config[key]);
  } catch {
    console.error(`brand.config.json: "${key}" no es una URL válida: ${config[key]}`);
    process.exit(1);
  }
}

if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(config.androidApplicationId)) {
  console.error(
    'brand.config.json: androidApplicationId debe tener forma de paquete Java, por ejemplo com.empresa.app',
  );
  process.exit(1);
}

if (!/^[a-z][a-z0-9-]*$/.test(config.slug)) {
  console.error(
    'brand.config.json: slug debe ir en minúsculas (letras, números y guiones), por ejemplo "miapp". ' +
      'Se usa en carpetas de datos, servicios del sistema y nombres de paquete.',
  );
  process.exit(1);
}

if (!/^[A-Za-z0-9.-]+$/.test(config.tauriIdentifier)) {
  console.error(
    'brand.config.json: tauriIdentifier solo admite letras, números, guiones y puntos.',
  );
  process.exit(1);
}

if (!/^[A-Za-z0-9._-]+$/.test(config.artifactPrefix)) {
  console.error(
    'brand.config.json: artifactPrefix solo admite letras, números, puntos, guiones y guiones bajos (sin espacios).',
  );
  process.exit(1);
}

if (Number.isNaN(Date.parse(config.releaseDate))) {
  console.error(`brand.config.json: releaseDate no es una fecha válida: ${config.releaseDate}`);
  process.exit(1);
}

// Claves PÚBLICAS de quien compila y publica la app. No son secretas, pero son
// de cada vendedor: con las de otro, la app rechaza las licencias de tu
// servidor, el updater rechaza tus actualizaciones y el APK firmado con tu
// keystore se cierra al abrirse. Vacías = sin configurar: --check falla.
const KEY_FIELDS = {
  licensePublicKey: {
    valid: (v) => /^MCowBQYDK2VwAyEA[A-Za-z0-9+/]{43}=$/.test(v),
    how: 'cd backend-server && npm run keys:generate && npm run keys:pub  (base64 de la SPKI Ed25519)',
  },
  updaterPublicKey: {
    valid: (v) => {
      try {
        return /minisign public key/.test(Buffer.from(v, 'base64').toString('utf8'));
      } catch {
        return false;
      }
    },
    how: 'npx tauri signer generate -w ~/.tauri/updater.key  y copia aquí el contenido de updater.key.pub',
  },
  androidReleaseSha256: {
    valid: (v) => /^[0-9A-Fa-f]{64}$/.test(v),
    how: 'keytool -exportcert -alias <alias> -keystore release.keystore | sha256sum  (64 caracteres hex)',
  },
};
const missingKeys = [];
for (const [key, rule] of Object.entries(KEY_FIELDS)) {
  const value = typeof config[key] === 'string' ? config[key].trim() : '';
  if (!value) {
    missingKeys.push(`${key}: ${rule.how}`);
    config[key] = '';
  } else if (!rule.valid(value)) {
    console.error(`brand.config.json: "${key}" no tiene el formato esperado. Se obtiene con: ${rule.how}`);
    process.exit(1);
  } else {
    config[key] = value;
  }
}

const client = path.join(root, 'app-client-desktop-and-mobile');
const backend = path.join(root, 'backend-server');
const backendPg = path.join(root, 'backend-server-pg');

const paths = {
  generated: path.join(client, 'src', 'config', 'brand.generated.ts'),
  backendBrand: path.join(backend, 'src', 'config', 'brand.ts'),
  backendPgBrand: path.join(backendPg, 'src', 'config', 'brand.ts'),
  tauri: path.join(client, 'src-tauri', 'tauri.conf.json'),
  capacitor: path.join(client, 'capacitor.config.ts'),
  gradle: path.join(client, 'android', 'app', 'build.gradle'),
  strings: path.join(client, 'android', 'app', 'src', 'main', 'res', 'values', 'strings.xml'),
  html: path.join(client, 'index.html'),
  rustApi: path.join(client, 'src-tauri', 'src', 'api.rs'),
  envExample: path.join(backend, '.env.example'),
  backendPgEnvExample: path.join(backendPg, '.env.example'),
  rustBrand: path.join(client, 'src-tauri', 'src', 'brand.rs'),
  cargo: path.join(client, 'src-tauri', 'Cargo.toml'),
  iss: path.join(client, 'installer', 'Setup.iss'),
  pkgbuild: path.join(client, 'packaging', 'arch', 'PKGBUILD'),
  desktopEntry: path.join(client, 'packaging', 'arch', 'app.desktop'),
  siteTemplate: path.join(root, 'site', 'downloads', 'index.template.html'),
  siteOut: path.join(root, 'site', 'downloads', 'index.html'),
  rustLicense: path.join(client, 'src-tauri', 'src', 'license.rs'),
  mainActivity: path.join(client, 'android', 'app', 'src', 'main', 'java', 'com', 'krakenges', 'fleet', 'MainActivity.java'),
};

// Archivos que este script genera enteros (pueden no existir todavía).
const GENERATED = new Set([
  'generated',
  'backendBrand',
  'backendPgBrand',
  'rustBrand',
  'desktopEntry',
  'siteOut',
]);

for (const [name, file] of Object.entries(paths)) {
  if (GENERATED.has(name)) continue;
  if (!fs.existsSync(file)) {
    console.error(`Falta el archivo ${name}: ${file}`);
    process.exit(1);
  }
}

const changes = [];

function record(label, file, nextContent) {
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (current === nextContent) return;
  changes.push(label);
  if (checkOnly) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, nextContent, 'utf8');
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function escapeXml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeHtml(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function setXmlString(xml, name, value) {
  const escaped = escapeXml(value);
  const pattern = new RegExp(`(<string name="${name}">)[\\s\\S]*?(</string>)`);
  if (pattern.test(xml)) return xml.replace(pattern, `$1${escaped}$2`);
  return xml.replace('</resources>', `    <string name="${name}">${escaped}</string>\n</resources>`);
}

function setEnvValue(content, key, value) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  if (pattern.test(content)) return content.replace(pattern, line);
  return content.endsWith('\n') ? `${content}${line}\n` : `${content}\n${line}\n`;
}

// 1. Cliente: valores de marca y API base.
const brandForClient = {
  appName: config.appName,
  slug: config.slug,
  shortName: config.shortName,
  appTitle: config.appTitle,
  appDescription: config.appDescription,
  tagline: config.tagline,
  companyName: config.companyName,
  copyright: config.copyright,
  supportUrl: config.supportUrl,
  logoUrl: config.logoUrl,
  logoSquare: config.logoSquare,
  faviconUrl: config.faviconUrl,
};

const generated = `// GENERADO por tools/brand/apply.mjs. No editar a mano.
// Fuente: brand.config.json

export const BRAND = ${JSON.stringify(brandForClient, null, 2)} as const;

/** Identificador Android. Debe coincidir con build.gradle y strings.xml. */
export const ANDROID_APPLICATION_ID = ${JSON.stringify(config.androidApplicationId)};

/**
 * Base de la API. Se puede sobrescribir en build con VITE_API_BASE.
 * Sin barra final para que las rutas no salgan con doble slash.
 */
export const API_BASE_URL = (
  (import.meta.env.VITE_API_BASE as string | undefined) || ${JSON.stringify(config.apiBaseUrl)}
).replace(/\\/+$/, '');
`;

record('cliente: src/config/brand.generated.ts', paths.generated, generated);

const backendBrand = `// GENERADO por tools/brand/apply.mjs. No editar a mano.
// Fuente: brand.config.json

export const BRAND_NAME = ${JSON.stringify(config.appName)};
export const BRAND_SHORT_NAME = ${JSON.stringify(config.shortName)};
/** Prefijo de los instaladores publicados (Tauri usa el productName). */
export const ARTIFACT_PREFIX = ${JSON.stringify(config.artifactPrefix)};
/** Web pública: origen permitido por CORS y URL por defecto si falta PUBLIC_BASE_URL. */
export const PUBLIC_BASE_URL = ${JSON.stringify(config.publicBaseUrl.replace(/\/+$/, ''))};
`;

record('backend: src/config/brand.ts', paths.backendBrand, backendBrand);
record('backend-pg: src/config/brand.ts', paths.backendPgBrand, backendBrand);

// 2. Tauri: nombre, identificador, título y endpoint del updater.
const tauri = JSON.parse(read(paths.tauri));
tauri.productName = config.appName;
tauri.identifier = config.tauriIdentifier;

if (!tauri.app || !Array.isArray(tauri.app.windows) || !tauri.app.windows[0]) {
  console.error('tauri.conf.json no tiene app.windows[0]; no se puede cambiar el título.');
  process.exit(1);
}
tauri.app.windows[0].title = config.windowTitle;

if (!tauri.plugins || !tauri.plugins.updater) {
  console.error('tauri.conf.json no tiene plugins.updater; no se puede cambiar el endpoint.');
  process.exit(1);
}
tauri.plugins.updater.endpoints = [config.updaterEndpoint];
tauri.plugins.updater.pubkey = config.updaterPublicKey;

record(
  'Tauri: productName, identifier, título y updater (endpoint y clave pública)',
  paths.tauri,
  `${JSON.stringify(tauri, null, 2)}\n`,
);

// 3. Android: applicationId (identidad de tienda) y textos.
//
// El `namespace` y el paquete Java se dejan como están a propósito: cambiarlos
// obliga a mover archivos .java y a tocar el manifiesto. No son marca visible.
const gradle = read(paths.gradle);
if (!/applicationId\s+"[^"]*"/.test(gradle)) {
  console.error('build.gradle no tiene applicationId con el formato esperado.');
  process.exit(1);
}
const nextGradle = gradle.replace(
  /applicationId\s+"[^"]*"/,
  `applicationId "${config.androidApplicationId}"`,
);
record('Android: applicationId', paths.gradle, nextGradle);

const tsSingle = (value) => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const capacitor = read(paths.capacitor);
if (!/appId:\s*'[^']*'/.test(capacitor) || !/appName:\s*'[^']*'/.test(capacitor)) {
  console.error('capacitor.config.ts no tiene appId/appName con el formato esperado.');
  process.exit(1);
}
const nextCapacitor = capacitor
  .replace(/appId:\s*'[^']*'/, `appId: '${tsSingle(config.androidApplicationId)}'`)
  .replace(/appName:\s*'[^']*'/, `appName: '${tsSingle(config.appName)}'`);
record('Capacitor: appId y appName', paths.capacitor, nextCapacitor);

let strings = read(paths.strings);
strings = setXmlString(strings, 'app_name', config.appName);
strings = setXmlString(strings, 'title_activity_main', config.appName);
strings = setXmlString(strings, 'package_name', config.androidApplicationId);
strings = setXmlString(strings, 'custom_url_scheme', config.androidApplicationId);
record('Android: strings.xml', paths.strings, strings);

// 4. index.html: título y metadatos.
let html = read(paths.html);
if (!/<title>[\s\S]*?<\/title>/.test(html)) {
  console.error('index.html no tiene <title>.');
  process.exit(1);
}
html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(config.appName)}</title>`);

const descriptionTag = `<meta name="description" content="${escapeXml(config.appDescription)}" />`;
const applicationNameTag = `<meta name="application-name" content="${escapeXml(config.appName)}" />`;

if (/<meta name="description"[^>]*>/.test(html)) {
  html = html.replace(/<meta name="description"[^>]*>/, descriptionTag);
} else {
  html = html.replace(/(<meta name="viewport"[^>]*>)/, `$1\n    ${descriptionTag}`);
}

if (/<meta name="application-name"[^>]*>/.test(html)) {
  html = html.replace(/<meta name="application-name"[^>]*>/, applicationNameTag);
} else {
  html = html.replace(descriptionTag, `${descriptionTag}\n    ${applicationNameTag}`);
}

record('cliente: index.html (título y metadatos)', paths.html, html);

// 5. Rust: API base por defecto. KRAKENGES_API_BASE sigue teniendo prioridad.
const rust = read(paths.rustApi);
if (!/const DEFAULT_API_BASE: &str = "[^"]*";/.test(rust)) {
  console.error('api.rs no tiene DEFAULT_API_BASE con el formato esperado.');
  process.exit(1);
}
const nextRust = rust.replace(
  /const DEFAULT_API_BASE: &str = "[^"]*";/,
  `const DEFAULT_API_BASE: &str = ${JSON.stringify(config.apiBaseUrl)};`,
);
record('Rust: API base por defecto', paths.rustApi, nextRust);

// 6. Backend: URLs públicas de ejemplo (sin secretos).
let envExample = read(paths.envExample);
envExample = setEnvValue(envExample, 'PUBLIC_BASE_URL', config.publicBaseUrl);
envExample = setEnvValue(envExample, 'DOWNLOAD_BASE_URL', config.downloadBaseUrl);
envExample = setEnvValue(envExample, 'APP_PUBLIC_URL', config.publicBaseUrl);
envExample = setEnvValue(envExample, 'RELEASE_DATE', config.releaseDate);
{
  const site = new URL(config.publicBaseUrl);
  const origins = [site.origin];
  if (!site.hostname.startsWith('www.')) origins.push(`${site.protocol}//www.${site.host}`);
  envExample = setEnvValue(envExample, 'CORS_ORIGIN', origins.join(','));
}
record('backend: .env.example (URLs públicas)', paths.envExample, envExample);

let envExamplePg = read(paths.backendPgEnvExample);
envExamplePg = setEnvValue(envExamplePg, 'PUBLIC_BASE_URL', config.publicBaseUrl);
envExamplePg = setEnvValue(envExamplePg, 'DOWNLOAD_BASE_URL', config.downloadBaseUrl);
envExamplePg = setEnvValue(envExamplePg, 'APP_PUBLIC_URL', config.publicBaseUrl);
envExamplePg = setEnvValue(envExamplePg, 'RELEASE_DATE', config.releaseDate);
{
  const site = new URL(config.publicBaseUrl);
  const origins = [site.origin];
  if (!site.hostname.startsWith('www.')) origins.push(`${site.protocol}//www.${site.host}`);
  envExamplePg = setEnvValue(envExamplePg, 'CORS_ORIGIN', origins.join(','));
}
record('backend-pg: .env.example (URLs públicas)', paths.backendPgEnvExample, envExamplePg);

// 7. Rust: constantes de marca para el motor de escritorio.
const rustStr = (value) => JSON.stringify(value); // JSON y Rust comparten el formato de "cadena".
const rustBrand = `// GENERADO por tools/brand/apply.mjs. No editar a mano.
// Fuente: brand.config.json

/// Nombre visible (carpeta de datos en Windows, mensajes, User-Agent de descargas).
pub const APP_NAME: &str = ${rustStr(config.appName)};
/// Nombre en minúsculas: carpetas de datos en Linux/macOS, clase de ventana.
pub const SLUG: &str = ${rustStr(config.slug)};
/// Identificador de la app (Tauri). También es el servicio del llavero del sistema.
pub const TAURI_IDENTIFIER: &str = ${rustStr(config.tauriIdentifier)};
`;
record('Rust: src-tauri/src/brand.rs', paths.rustBrand, rustBrand);

let cargo = read(paths.cargo);
if (!/^description = ".*"$/m.test(cargo) || !/^authors = \[.*\]$/m.test(cargo)) {
  console.error('Cargo.toml no tiene description/authors con el formato esperado.');
  process.exit(1);
}
cargo = cargo
  .replace(/^description = ".*"$/m, `description = ${rustStr(config.appTitle)}`)
  .replace(/^authors = \[.*\]$/m, `authors = [${rustStr(config.companyName)}]`);
record('Cargo.toml: descripción y autor', paths.cargo, cargo);

// 8. Instalador de Windows (Inno Setup): solo las líneas #define.
const issString = (value) => `"${value.replace(/"/g, '""')}"`;
let iss = read(paths.iss);
const issDefines = {
  MyAppName: config.appName,
  MyAppPublisher: config.companyName,
  MyAppURL: config.publicBaseUrl.replace(/\/+$/, ''),
  MyAppExeName: `${config.appName}.exe`,
  MyArtifactPrefix: config.artifactPrefix,
  MyAppAssocExt: `.${config.slug}`,
};
for (const [key, value] of Object.entries(issDefines)) {
  const pattern = new RegExp(`^#define ${key} .*$`, 'm');
  if (!pattern.test(iss)) {
    console.error(`installer/Setup.iss no tiene "#define ${key}".`);
    process.exit(1);
  }
  iss = iss.replace(pattern, `#define ${key} ${issString(value)}`);
}
record('Instalador Windows: installer/Setup.iss', paths.iss, iss);

// 9. Paquete de Arch: variables de marca del PKGBUILD y el .desktop.
const shDouble = (value) => `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
let pkgbuild = read(paths.pkgbuild);
const pkgVars = {
  _slug: config.slug,
  _appname: shDouble(config.appName),
  _identifier: config.tauriIdentifier,
  _url: shDouble(config.publicBaseUrl),
  _desc: shDouble(config.appTitle),
};
for (const [key, value] of Object.entries(pkgVars)) {
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  if (!pattern.test(pkgbuild)) {
    console.error(`packaging/arch/PKGBUILD no tiene la variable ${key}.`);
    process.exit(1);
  }
  pkgbuild = pkgbuild.replace(pattern, `${key}=${value}`);
}
pkgbuild = pkgbuild.replace(/^# Maintainer: .*$/m, `# Maintainer: ${config.companyName} <${config.supportUrl}>`);
record('Arch: packaging/arch/PKGBUILD', paths.pkgbuild, pkgbuild);

const desktopEntry = `[Desktop Entry]
Type=Application
Name=${config.appName}
Comment=${config.appTitle}
Exec=/usr/bin/${config.slug}
Icon=${config.slug}
Terminal=false
Categories=Network;WebBrowser;
StartupWMClass=${config.slug}
`;
record('Arch: packaging/arch/app.desktop', paths.desktopEntry, desktopEntry);

// 10. Página pública de descargas, desde su plantilla.
const appVersion = JSON.parse(read(paths.tauri)).version;
const siteValues = {
  APP_NAME: escapeHtml(config.appName),
  ARTIFACT_PREFIX: escapeHtml(config.artifactPrefix),
  VERSION: escapeHtml(appVersion),
  COPYRIGHT: escapeHtml(config.copyright),
};
const siteHtml = read(paths.siteTemplate)
  .replace(/^<!--[\s\S]*?-->\n/, '') // el aviso de plantilla no va al HTML final
  .replace(/\{\{([A-Z_]+)\}\}/g, (match, key) => {
    if (!(key in siteValues)) {
      console.error(`index.template.html usa {{${key}}}, que no existe.`);
      process.exit(1);
    }
    return siteValues[key];
  });
record('Web: site/downloads/index.html', paths.siteOut, siteHtml);

// 11. Claves públicas de quien publica (ver KEY_FIELDS).
let licenseRs = read(paths.rustLicense);
const licensePattern = /(const LICENSE_PUBLIC_KEY_SPKI_B64: &str =\s*)"[^"]*";/;
if (!licensePattern.test(licenseRs)) {
  console.error('license.rs no tiene LICENSE_PUBLIC_KEY_SPKI_B64 con el formato esperado.');
  process.exit(1);
}
licenseRs = licenseRs.replace(licensePattern, `$1${JSON.stringify(config.licensePublicKey)};`);
record('Rust: clave pública de licencias (license.rs)', paths.rustLicense, licenseRs);

let mainActivity = read(paths.mainActivity);
const signaturePattern = /(private static final String OFFICIAL_RELEASE_SIGNATURE =\s*)"[^"]*";/;
if (!signaturePattern.test(mainActivity)) {
  console.error('MainActivity.java no tiene OFFICIAL_RELEASE_SIGNATURE con el formato esperado.');
  process.exit(1);
}
mainActivity = mainActivity.replace(signaturePattern, `$1"${config.androidReleaseSha256.toUpperCase()}";`);
record('Android: huella de la keystore de release (MainActivity.java)', paths.mainActivity, mainActivity);

if (checkOnly) {
  if (missingKeys.length > 0 && !templateMode) {
    console.error('Faltan claves públicas propias en brand.config.json. Sin ellas la app no funciona con tu servidor ni tu firma:');
    for (const line of missingKeys) console.error(` - ${line}`);
    console.error('Paso a paso: docs/PUESTA-EN-MARCHA.md');
    process.exit(1);
  }
  if (missingKeys.length > 0 && templateMode) {
    console.log('Modo plantilla: claves públicas vacías; el comprador debe generarlas.');
  }
  if (changes.length > 0) {
    console.error('La marca no está aplicada. Ejecuta: node tools/brand/apply.mjs');
    for (const change of changes) console.error(` - ${change}`);
    process.exit(1);
  }
  console.log(`Marca en sync: ${config.appName}${templateMode ? ' (plantilla)' : ''}`);
  process.exit(0);
}

if (changes.length === 0) {
  console.log(`Marca ya aplicada: ${config.appName}`);
} else {
  console.log(`Marca aplicada: ${config.appName}`);
  for (const change of changes) console.log(` - ${change}`);
  console.log('');
  console.log('Recuerda:');
  console.log(' - Reemplazar los iconos (public/, src-tauri/icons/ y mipmaps de Android).');
  console.log(' - Copiar las URLs públicas al .env real del backend.');
  console.log(' - Si cambiaste el identificador, la app se instala como una aplicación nueva.');
}
if (missingKeys.length > 0) {
  console.log('');
  console.log('PENDIENTE: claves públicas propias (el build fallará hasta ponerlas):');
  for (const line of missingKeys) console.log(` - ${line}`);
  console.log('Paso a paso: docs/PUESTA-EN-MARCHA.md');
}
