#!/usr/bin/env node
/**
 * Escaneo previo al empaquetado de venta.
 *
 * Busca ficheros que no deben entregarse y secretos evidentes en el contenido.
 * No es un escáner de secretos perfecto: es una barrera barata antes de crear
 * el tarball. No sustituye a revisar el paquete final ni a rotar credenciales.
 *
 * Uso:
 *   node tools/delivery-scan/check.mjs
 *   node tools/delivery-scan/check.mjs --all
 *   node tools/delivery-scan/check.mjs --json
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MAX_TEXT_BYTES = 1_500_000;

const EXCLUDED_DIRS = new Set([
  '.git',
  '.playwright-mcp',
  'node_modules',
  'dist',
  'target',
  'coverage',
  'releases-instaladores',
  'credenciales',
  'backend-server/keys',
]);

const FORBIDDEN_BASENAMES = new Set([
  '.env',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'id_dsa',
  'tauri-updater.key',
  'updater-manifest.json',
  'server_session.json',
  'krakenges_db.json',
  'owner_credentials.txt',
  'google-services.json',
  'GoogleService-Info.plist',
]);

const FORBIDDEN_EXTENSIONS = [
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.jks',
  '.keystore',
  '.kdbx',
  '.sqlite',
  '.sqlite3',
  '.db',
  '.dump',
  '.log',
];

const SECRET_PATTERNS = [
  {
    name: 'bloque de clave privada',
    regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/,
  },
  { name: 'token de GitHub', regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/ },
  { name: 'GitHub PAT', regex: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { name: 'clave OpenAI', regex: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: 'clave Anthropic', regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'clave AWS', regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'clave Google', regex: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'token Slack', regex: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
  { name: 'clave Stripe', regex: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{20,}\b/ },
  { name: 'JWT_SECRET', regex: /^\s*(?:export\s+)?JWT_SECRET\s*[:=]\s*(.*)$/ },
  { name: 'SESSION_SECRET', regex: /^\s*(?:export\s+)?SESSION_SECRET\s*[:=]\s*(.*)$/ },
  { name: 'MONGO_URI', regex: /^\s*(?:export\s+)?(?:MONGO_URI|MONGODB_URI)\s*[:=]\s*(.*)$/ },
  {
    name: 'TAURI_SIGNING_PRIVATE_KEY',
    regex: /^\s*(?:export\s+)?TAURI_SIGNING_PRIVATE_KEY\s*[:=]\s*(.*)$/,
  },
  {
    name: 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
    regex: /^\s*(?:export\s+)?TAURI_SIGNING_PRIVATE_KEY_PASSWORD\s*[:=]\s*(.*)$/,
  },
  {
    name: 'KRAKENGES_LICENSE_PRIVATE_KEY',
    regex: /^\s*(?:export\s+)?KRAKENGES_LICENSE_PRIVATE_KEY\s*[:=]\s*(.*)$/,
  },
  {
    name: 'KRAKENGES_PROXY_ENCRYPTION_KEY',
    regex: /^\s*(?:export\s+)?KRAKENGES_PROXY_ENCRYPTION_KEY\s*[:=]\s*(.*)$/,
  },
  { name: 'RESEND_API_KEY', regex: /^\s*(?:export\s+)?RESEND_API_KEY\s*[:=]\s*(.*)$/ },
  { name: 'SMTP_PASSWORD', regex: /^\s*(?:export\s+)?SMTP_(?:PASS|PASSWORD)\s*[:=]\s*(.*)$/ },
  {
    name: 'contraseña de VPS',
    regex: /^\s*(?:export\s+)?VPS_SUDO_PASSWORD\s*[:=]\s*(.*)$/,
  },
];

const { values } = parseArgs({
  options: {
    all: { type: 'boolean' },
    json: { type: 'boolean' },
    help: { type: 'boolean' },
  },
  allowPositionals: false,
});

if (values.help) {
  console.log(`Escaneo previo al paquete de venta.

Opciones:
  --all    Recorre el árbol de trabajo, no solo los ficheros versionados.
  --json   Imprime el resultado en JSON.
  --help   Muestra esta ayuda.

Sin --all usa git ls-files. Si no hay git, recorre el árbol con las exclusiones
habituales (node_modules, dist, target, .git, releases-instaladores, etc.).`);
  process.exit(0);
}

function isExcluded(relativePath) {
  const parts = relativePath.split('/');
  for (let index = 0; index < parts.length; index += 1) {
    const prefix = parts.slice(0, index + 1).join('/');
    if (EXCLUDED_DIRS.has(prefix)) return true;
  }
  // También excluye node_modules, target, dist, etc. anidados dentro de una app.
  return parts.some((part) => EXCLUDED_DIRS.has(part));
}

function forbiddenPath(relativePath) {
  const base = path.posix.basename(relativePath);
  if (base === '.env') return true;
  if (FORBIDDEN_BASENAMES.has(base)) return true;
  if (FORBIDDEN_EXTENSIONS.some((extension) => base.endsWith(extension))) return true;
  return false;
}

function walk(directory, relative = '') {
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (!isExcluded(nextRelative)) found.push(...walk(path.join(directory, entry.name), nextRelative));
    } else if (entry.isFile()) {
      found.push(nextRelative);
    }
  }
  return found;
}

function listTracked() {
  try {
    const output = execFileSync('git', ['-C', root, 'ls-files', '-z'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return output.split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

function looksBinary(buffer) {
  return buffer.subarray(0, 8192).includes(0);
}

function allowedAssignment(value, patternName) {
  const normalized = value
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .trim();
  if (!normalized) return true;
  if (/^(\$|<|\.\.\.|CAMBIAR|CHANGE|PLACEHOLDER|TU_|your|example|test|ci|fake|dummy|TODO)/i.test(normalized)) {
    return true;
  }
  if (normalized.includes('${{') || normalized.includes('process.env') || normalized.includes('$(')) {
    return true;
  }
  if (patternName === 'MONGO_URI') {
    if (/(CAMBIAR|usuario:clave|usuario_backup|:clave@|example|localhost|127\.0\.0\.1)/i.test(normalized)) {
      return true;
    }
  }
  if (patternName === 'TAURI_SIGNING_PRIVATE_KEY' && normalized.includes('\\n')) {
    return true;
  }
  return false;
}

const tracked = values.all ? null : listTracked();
const files = (tracked ?? walk(root)).sort();
const findings = [];
let scanned = 0;

for (const relativePath of files) {
  if (values.all && isExcluded(relativePath)) continue;
  if (forbiddenPath(relativePath)) {
    findings.push({ file: relativePath, line: 0, type: 'fichero prohibido' });
    continue;
  }

  const absolutePath = path.join(root, relativePath);
  let stats;
  try {
    stats = fs.statSync(absolutePath);
  } catch {
    continue;
  }
  if (!stats.isFile() || stats.size > MAX_TEXT_BYTES) continue;

  let buffer;
  try {
    buffer = fs.readFileSync(absolutePath);
  } catch {
    continue;
  }
  if (looksBinary(buffer)) continue;
  scanned += 1;

  const lines = buffer.toString('utf8').split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    for (const pattern of SECRET_PATTERNS) {
      const match = line.match(pattern.regex);
      if (!match) continue;
      if (
        pattern.name === 'bloque de clave privada' &&
        (line.includes('...') || /CAMBIAR|PLACEHOLDER|EXAMPLE/i.test(line))
      ) {
        continue;
      }
      const value = match[1] ?? '';
      if (allowedAssignment(value, pattern.name)) continue;
      findings.push({
        file: relativePath,
        line: lineIndex + 1,
        type: pattern.name,
      });
    }
  }
}

const report = {
  ok: findings.length === 0,
  scanned,
  findings,
};

if (values.json) {
  console.log(JSON.stringify(report, null, 2));
} else if (findings.length === 0) {
  console.log(`Escaneo OK: ${scanned} ficheros de texto revisados, 0 hallazgos.`);
} else {
  console.error(`Escaneo con ${findings.length} hallazgo(s):`);
  for (const finding of findings) {
    const location = finding.line > 0 ? `${finding.file}:${finding.line}` : finding.file;
    console.error(` - ${location}: ${finding.type}`);
  }
  console.error('No empaquetes hasta revisar o eliminar estos elementos.');
}

if (findings.length > 0) process.exitCode = 1;
