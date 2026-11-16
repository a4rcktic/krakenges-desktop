#!/usr/bin/env node
// Genera el par de claves ed25519 para firmar licencias.
//  - .keys/license_ed25519.pem        -> PRIVADA (NUNCA en el repo, va al VPS/secret manager)
//  - .keys/license_ed25519_pub.pem    -> pública (solo local; el cliente incrusta la base64)
// Imprime la clave pública en base64 SPKI listo para incrustar en el binario Tauri.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const keysDir = process.env.KRAKENGES_LICENSE_KEYS_DIR || path.join(__dirname, '..', '.keys');

fs.mkdirSync(keysDir, { recursive: true });
fs.chmodSync(keysDir, 0o700);

const privPath = path.join(keysDir, 'license_ed25519.pem');
const pubPath = path.join(keysDir, 'license_ed25519_pub.pem');

if (fs.existsSync(privPath)) {
  // Conservar el par existente: regenerar rompería TODOS los binarios ya desplegados.
  const pub = crypto.createPublicKey(fs.readFileSync(pubPath));
  console.error('Ya existe un par de claves. No se regenera (rotarla invalida binarios existentes).');
  console.log(pub.export({ type: 'spki', format: 'der' }).toString('base64'));
  process.exit(0);
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
fs.writeFileSync(privPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
fs.writeFileSync(pubPath, publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o644 });

console.error(`Par de claves generado en ${keysDir}`);
console.error('PRIVADA: NUNCA la subas a git. En producción vé en KRAKENGES_LICENSE_PRIVATE_KEY (base64 de la PKCS8 pem).');
console.log(publicKey.export({ type: 'spki', format: 'der' }).toString('base64'));