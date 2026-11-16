#!/usr/bin/env node
/**
 * Genera el `updater-manifest.json` que sirve `/api/updates/manifest`.
 *
 * Formatos de entrada:
 *   --latest latest.json   Manifiesto nativo de Tauri (lo genera tauri-action).
 *   --artifacts <dir>      Directorio con los artefactos y sus ficheros .sig.
 *
 * El manifiesto de salida usa el formato nativo de Tauri:
 *
 *   {
 *     "version": "1.0.1",
 *     "notes": "...",
 *     "pub_date": "2026-10-20T12:00:00.000Z",
 *     "platforms": {
 *       "linux-x86_64": { "signature": "...", "url": "https://..." },
 *       "windows-x86_64": { "signature": "...", "url": "https://..." }
 *     }
 *   }
 *
 * Las URLs se reescriben al host público de descargas. La firma NO se toca:
 * Tauri la verifica con la clave pública del updater.
 *
 * Uso:
 *   node tools/updater-manifest/generate.mjs --latest latest.json
 *   node tools/updater-manifest/generate.mjs --artifacts ./updater --version 1.0.1
 *   node tools/updater-manifest/generate.mjs --latest latest.json --check
 *   node tools/updater-manifest/generate.mjs --self-test
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_OUTPUT = path.join(root, 'backend-server', 'updater-manifest.json');
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const TARGET_RE = /^(linux|windows|darwin)-(x86_64|aarch64|i686|armv7)$/;

const USAGE = `Genera el manifiesto del updater de Tauri.

Opciones:
  --latest <fichero>       Lee un latest.json generado por tauri-action.
  --artifacts <dir>        Lee los .sig y artefactos de un directorio.
  --version <semver>       Versión publicada. Obligatoria con --artifacts.
  --notes <texto>          Notas de la release. Por defecto, las del latest.json.
  --pub-date <ISO>         Fecha de publicación. Por defecto, la del latest.json
                           o la hora de generación.
  --base-url <url>         Host público de los artefactos. Por defecto,
                           updaterDownloadBaseUrl de brand.config.json.
  --keep-urls              No reescribe las URLs del latest.json.
  --output <fichero>       Destino. Por defecto, backend-server/updater-manifest.json.
  --check                  Compara con el destino y sale con 1 si difiere.
  --dry-run                Imprime el manifiesto sin escribirlo.
  --self-test              Prueba el generador con fixtures temporales.
  --help                   Muestra esta ayuda.

Ejemplos:
  node tools/updater-manifest/generate.mjs --latest latest.json
  node tools/updater-manifest/generate.mjs --artifacts ./updater --version 1.0.1
  node tools/updater-manifest/generate.mjs --latest latest.json --check
`;

function fail(message) {
  throw new Error(message);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeVersion(value) {
  const version = String(value ?? '')
    .trim()
    .replace(/^v/, '');
  if (!VERSION_RE.test(version)) {
    fail(`Versión no válida: ${JSON.stringify(value)}. Usa semver, por ejemplo 1.0.1.`);
  }
  return version;
}

function normalizeDate(value) {
  if (!value) return new Date().toISOString();
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    fail(`pub_date no es una fecha válida: ${JSON.stringify(value)}`);
  }
  return new Date(timestamp).toISOString();
}

function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`La base de descargas no es una URL válida: ${JSON.stringify(value)}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    fail(`La base de descargas debe usar http o https: ${value}`);
  }
  if (url.search || url.hash) {
    fail(`La base de descargas no puede llevar query ni fragmento: ${value}`);
  }
  return value.replace(/\/+$/, '');
}

function assertHttpUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${label} no es una URL válida: ${JSON.stringify(value)}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    fail(`${label} debe usar http o https: ${value}`);
  }
  return url;
}

function fileNameFromUrl(value) {
  const url = assertHttpUrl(value, 'La URL del artefacto');
  const encodedName = path.posix.basename(url.pathname);
  if (!encodedName) {
    fail(`La URL del artefacto no tiene nombre de fichero: ${value}`);
  }
  try {
    return decodeURIComponent(encodedName);
  } catch {
    fail(`El nombre de fichero de la URL no está bien codificado: ${value}`);
  }
}

function sortPlatforms(platforms) {
  return Object.fromEntries(
    Object.entries(platforms).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
}

function brandUpdaterBaseUrl() {
  const configPath = path.join(root, 'brand.config.json');
  if (!fs.existsSync(configPath)) {
    fail(`No existe ${configPath}. Pasa --base-url o crea brand.config.json.`);
  }

  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    fail(`brand.config.json no es JSON válido: ${error.message}`);
  }

  const configured =
    config.updaterDownloadBaseUrl ||
    (nonEmptyString(config.downloadBaseUrl) ? `${config.downloadBaseUrl.replace(/\/+$/, '')}/updater` : '');
  if (!nonEmptyString(configured)) {
    fail('brand.config.json no tiene updaterDownloadBaseUrl ni downloadBaseUrl.');
  }
  return normalizeBaseUrl(configured);
}

function readJsonFile(file) {
  if (!fs.existsSync(file)) {
    fail(`No existe el fichero: ${file}`);
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`No se pudo leer ${file}: ${error.message}`);
  }
}

function artifactTarget(fileName) {
  const lower = fileName.toLowerCase();

  // Tauri 2.12+ firma también el AppImage directo, sin el .tar.gz. El
  // actualizador nativo lo acepta y lo instala sin desempaquetar.
  if (lower.endsWith('.appimage') || lower.endsWith('.appimage.tar.gz')) {
    if (/(aarch64|arm64)/.test(lower)) return 'linux-aarch64';
    if (/armv7/.test(lower)) return 'linux-armv7';
    if (/(i686|i386)/.test(lower)) return 'linux-i686';
    return 'linux-x86_64';
  }

  // Tauri 2.12+ también firma el instalador NSIS/MSI directo, sin .zip.
  if (
    lower.endsWith('.exe') ||
    lower.endsWith('.msi') ||
    lower.endsWith('.nsis.zip') ||
    lower.endsWith('.msi.zip')
  ) {
    if (/(aarch64|arm64)/.test(lower)) return 'windows-aarch64';
    return 'windows-x86_64';
  }

  if (lower.endsWith('.app.tar.gz')) {
    if (/(aarch64|arm64)/.test(lower)) return 'darwin-aarch64';
    return 'darwin-x86_64';
  }

  fail(
    `No se reconoce la plataforma de ${fileName}. ` +
      'Se aceptan .AppImage, .AppImage.tar.gz, .exe, .msi, .nsis.zip, .msi.zip y .app.tar.gz.',
  );
}

function buildFromLatest(latest, options) {
  if (!latest || typeof latest !== 'object' || Array.isArray(latest)) {
    fail('latest.json debe ser un objeto JSON.');
  }

  const latestVersion = nonEmptyString(latest.version) ? normalizeVersion(latest.version) : null;
  if (!latestVersion && !options.version) {
    fail('latest.json no trae version. Pasa --version.');
  }
  if (latestVersion && options.version && latestVersion !== normalizeVersion(options.version)) {
    fail(`La versión de latest.json (${latestVersion}) no coincide con --version (${options.version}).`);
  }
  const version = latestVersion ?? normalizeVersion(options.version);

  const platforms = latest.platforms;
  if (!platforms || typeof platforms !== 'object' || Array.isArray(platforms)) {
    fail('latest.json no trae un objeto platforms.');
  }

  const entries = {};
  for (const [target, value] of Object.entries(platforms)) {
    if (!TARGET_RE.test(target)) {
      fail(`Plataforma no válida en latest.json: ${JSON.stringify(target)}`);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      fail(`La entrada ${target} de latest.json no es un objeto.`);
    }
    if (!nonEmptyString(value.signature)) {
      fail(`La entrada ${target} no tiene firma.`);
    }
    if (!nonEmptyString(value.url)) {
      fail(`La entrada ${target} no tiene URL.`);
    }

    let url;
    if (options.keepUrls) {
      url = assertHttpUrl(value.url, `La URL de ${target}`).toString();
    } else {
      const fileName = fileNameFromUrl(value.url);
      url = `${options.baseUrl}/${version}/${encodeURIComponent(fileName)}`;
    }

    entries[target] = {
      signature: value.signature.trim(),
      url,
    };
  }

  if (Object.keys(entries).length === 0) {
    fail('latest.json no trae ninguna plataforma.');
  }

  const notes =
    options.notes !== undefined
      ? options.notes
      : typeof latest.notes === 'string'
        ? latest.notes
        : '';
  const pubDate = normalizeDate(options.pubDate || latest.pub_date);

  return {
    version,
    notes,
    pub_date: pubDate,
    platforms: sortPlatforms(entries),
  };
}

function buildFromArtifacts(directory, options) {
  if (!options.version) {
    fail('Con --artifacts hace falta --version.');
  }
  if (options.keepUrls) {
    fail('--keep-urls solo vale con --latest; los artefactos necesitan una URL pública.');
  }

  const version = normalizeVersion(options.version);
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    fail(`No existe el directorio de artefactos: ${directory}`);
  }

  const signatures = fs
    .readdirSync(directory)
    .filter((name) => name.toLowerCase().endsWith('.sig'))
    .sort();
  if (signatures.length === 0) {
    fail(`No hay ficheros .sig en ${directory}.`);
  }

  const entries = {};
  for (const signatureName of signatures) {
    const artifactName = signatureName.slice(0, -'.sig'.length);
    const artifactPath = path.join(directory, artifactName);
    if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
      fail(`Falta el artefacto ${artifactName} para ${signatureName}.`);
    }

    const target = artifactTarget(artifactName);
    if (entries[target]) {
      fail(
        `Hay más de un artefacto para ${target}: ` +
          `${entries[target].fileName} y ${artifactName}. Usa --latest o deja solo uno.`,
      );
    }

    const signature = fs.readFileSync(path.join(directory, signatureName), 'utf8').trim();
    if (!signature) {
      fail(`La firma ${signatureName} está vacía.`);
    }

    entries[target] = {
      fileName: artifactName,
      signature,
      url: `${options.baseUrl}/${version}/${encodeURIComponent(artifactName)}`,
    };
  }

  const platforms = {};
  for (const [target, entry] of Object.entries(entries)) {
    platforms[target] = { signature: entry.signature, url: entry.url };
  }

  return {
    version,
    notes: options.notes ?? '',
    pub_date: normalizeDate(options.pubDate),
    platforms: sortPlatforms(platforms),
  };
}

function formatManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function writeManifest(file, manifest) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, formatManifest(manifest), 'utf8');
}

function runSelfTest() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'krakenges-updater-manifest-'));
  try {
    const artifacts = path.join(temporary, 'artifacts');
    fs.mkdirSync(artifacts, { recursive: true });

    const linuxArtifact = 'KrakenGes_1.0.1_amd64.AppImage';
    const windowsArtifact = 'KrakenGes_1.0.1_x64-setup.exe';
    fs.writeFileSync(path.join(artifacts, linuxArtifact), 'linux-binary');
    fs.writeFileSync(path.join(artifacts, `${linuxArtifact}.sig`), 'linux-signature\n');
    fs.writeFileSync(path.join(artifacts, windowsArtifact), 'windows-binary');
    fs.writeFileSync(path.join(artifacts, `${windowsArtifact}.sig`), 'windows-signature\n');

    const manifest = buildFromArtifacts(artifacts, {
      version: '1.0.1',
      notes: 'Prueba',
      pubDate: '2026-10-20T12:00:00Z',
      baseUrl: 'https://downloads.example.com/updater',
    });

    assert.equal(manifest.version, '1.0.1');
    assert.equal(manifest.pub_date, '2026-10-20T12:00:00.000Z');
    assert.deepEqual(Object.keys(manifest.platforms), ['linux-x86_64', 'windows-x86_64']);
    assert.equal(
      manifest.platforms['linux-x86_64'].url,
      `https://downloads.example.com/updater/1.0.1/${linuxArtifact}`,
    );
    assert.equal(manifest.platforms['linux-x86_64'].signature, 'linux-signature');
    assert.equal(
      manifest.platforms['windows-x86_64'].url,
      `https://downloads.example.com/updater/1.0.1/${windowsArtifact}`,
    );

    const output = path.join(temporary, 'updater-manifest.json');
    writeManifest(output, manifest);
    assert.ok(isDeepStrictEqual(readJsonFile(output), manifest));

    const latest = {
      version: '1.0.1',
      notes: 'Desde latest',
      pub_date: '2026-10-20T13:00:00Z',
      platforms: {
        'linux-x86_64': {
          signature: 'latest-signature',
          url: 'https://github.com/example/releases/download/v1.0.1/KrakenGes_1.0.1_amd64.AppImage?download=1',
        },
      },
    };

    const rewritten = buildFromLatest(latest, {
      baseUrl: 'https://downloads.example.com/updater',
    });
    assert.equal(rewritten.notes, 'Desde latest');
    assert.equal(
      rewritten.platforms['linux-x86_64'].url,
      `https://downloads.example.com/updater/1.0.1/${linuxArtifact}`,
    );

    const kept = buildFromLatest(latest, { keepUrls: true });
    assert.equal(kept.platforms['linux-x86_64'].url, latest.platforms['linux-x86_64'].url);

    assert.throws(
      () =>
        buildFromLatest(
          {
            version: '1.0.1',
            platforms: { 'linux-x86_64': { signature: '', url: 'https://example.com/a' } },
          },
          { baseUrl: 'https://downloads.example.com/updater' },
        ),
      /no tiene firma/,
    );

    fs.writeFileSync(path.join(artifacts, 'KrakenGes_1.0.1_x64.AppImage.tar.gz'), 'duplicate');
    fs.writeFileSync(path.join(artifacts, 'KrakenGes_1.0.1_x64.AppImage.tar.gz.sig'), 'duplicate-signature');
    assert.throws(
      () =>
        buildFromArtifacts(artifacts, {
          version: '1.0.1',
          baseUrl: 'https://downloads.example.com/updater',
        }),
      /más de un artefacto/,
    );

    console.log('Self-test OK: manifiesto, firmas, URLs y duplicados.');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function main() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        latest: { type: 'string' },
        artifacts: { type: 'string' },
        version: { type: 'string' },
        notes: { type: 'string' },
        'pub-date': { type: 'string' },
        'base-url': { type: 'string' },
        'keep-urls': { type: 'boolean' },
        output: { type: 'string' },
        check: { type: 'boolean' },
        'dry-run': { type: 'boolean' },
        'self-test': { type: 'boolean' },
        help: { type: 'boolean' },
      },
      allowPositionals: false,
    }));
  } catch (error) {
    console.error(`Error: ${error.message}`);
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }

  if (values.help) {
    console.log(USAGE);
    return;
  }

  if (values['self-test']) {
    runSelfTest();
    return;
  }

  if (values.latest && values.artifacts) {
    fail('Usa --latest o --artifacts, no los dos.');
  }
  if (!values.latest && !values.artifacts) {
    fail('Falta --latest o --artifacts. Usa --help para ver los ejemplos.');
  }
  if (values['keep-urls'] && values['base-url']) {
    fail('No combines --keep-urls con --base-url.');
  }

  const baseUrl = values['keep-urls']
    ? null
    : normalizeBaseUrl(values['base-url'] || brandUpdaterBaseUrl());
  const options = {
    version: values.version,
    notes: values.notes,
    pubDate: values['pub-date'],
    baseUrl,
    keepUrls: Boolean(values['keep-urls']),
  };

  const manifest = values.latest
    ? buildFromLatest(readJsonFile(path.resolve(process.cwd(), values.latest)), options)
    : buildFromArtifacts(path.resolve(process.cwd(), values.artifacts), options);

  const output = values.output
    ? path.resolve(process.cwd(), values.output)
    : DEFAULT_OUTPUT;

  if (values['dry-run']) {
    process.stdout.write(formatManifest(manifest));
    return;
  }

  if (values.check) {
    if (!fs.existsSync(output)) {
      fail(`No existe el manifiesto ${output}. Genera uno antes de comprobar.`);
    }
    const current = readJsonFile(output);
    if (!isDeepStrictEqual(current, manifest)) {
      console.error(`El manifiesto ${output} está desincronizado.`);
      console.error('Vuelve a generarlo sin --check.');
      process.exitCode = 1;
      return;
    }
    console.log(`Manifiesto en sync: v${manifest.version} (${Object.keys(manifest.platforms).join(', ')})`);
    return;
  }

  writeManifest(output, manifest);
  console.log(
    `Manifiesto escrito: ${output} (v${manifest.version}, ${Object.keys(manifest.platforms).join(', ')})`,
  );
}

try {
  if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    main();
  }
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
}

export {
  artifactTarget,
  buildFromArtifacts,
  buildFromLatest,
  formatManifest,
  normalizeBaseUrl,
  normalizeDate,
  normalizeVersion,
};
