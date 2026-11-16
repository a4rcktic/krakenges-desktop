import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import type { IUser } from '../models/User';

/**
 * Tickets de licencia firmados con ed25519.
 *
 * El VPS posee el par de claves (persistido en `config.licenseKeysDir`). La
 * clave PÚBLICA se incrusta en el cliente Tauri, de modo que la app puede
 * verificar la autenticidad de un ticket sin red: un ticket forjado o un
 * payload re-escrito localmente no pasan la verificación.
 *
 * Formato del ticket: base64url(payloadJson) + '.' + base64url(signature)
 * El payload va en ASCII antes de firmar, por lo que la app puede recomputar
 * la firma sin parsear.
 */

export const TICKET_VERSION = 1;
export const KEY_VERSION = 1;

export interface TicketPayload {
  v: number;
  kid: number; // versión del par de claves (permite rotación sin invalidar tickets viejos)
  sub: string; // userId
  name: string;
  username: string;
  role: string;
  plan: string;
  exp: number | null; // planExpiresAt epoch ms (null = lifetime/ghost)
  lt: boolean; // isLifetime
  cr: number; // sellerCredits
  iat: number;
}

function loadOrCreateKeyPair(): { publicKey: crypto.KeyObject; privateKey: crypto.KeyObject } {
  // Producción: la privada llega por env (secret manager del VPS). Nunca en el repo.
  const envPriv = process.env.KRAKENGES_LICENSE_PRIVATE_KEY;
  if (envPriv) {
    const privateKey = crypto.createPrivateKey({
      key: Buffer.from(envPriv, 'base64'),
      type: 'pkcs8',
      format: 'der',
    });
    const publicKey = crypto.createPublicKey(privateKey);
    return { publicKey, privateKey };
  }

  const privPath = path.join(config.licenseKeysDir, 'license_ed25519.pem');
  const pubPath = path.join(config.licenseKeysDir, 'license_ed25519_pub.pem');

  if (!fs.existsSync(config.licenseKeysDir)) {
    fs.mkdirSync(config.licenseKeysDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(config.licenseKeysDir, 0o700);
  }

  if (!fs.existsSync(privPath) || !fs.existsSync(pubPath)) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(privPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    fs.writeFileSync(pubPath, publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o644 });
    return { publicKey, privateKey };
  }

  const privateKey = crypto.createPrivateKey(fs.readFileSync(privPath));
  const publicKey = crypto.createPublicKey(fs.readFileSync(pubPath));
  return { publicKey, privateKey };
}

let cachedPair: { publicKey: crypto.KeyObject; privateKey: crypto.KeyObject } | null = null;
export function getKeyPair(): { publicKey: crypto.KeyObject; privateKey: crypto.KeyObject } {
  if (!cachedPair) {
    cachedPair = loadOrCreateKeyPair();
  }
  return cachedPair;
}

export function publicKeyPem(): string {
  return getKeyPair().publicKey.export({ type: 'spki', format: 'pem' }).toString();
}

/** Construye el payload del ticket a partir de un usuario de la BD. */
function buildPayload(user: IUser): TicketPayload {
  return {
    v: TICKET_VERSION,
    kid: KEY_VERSION,
    sub: user._id.toString(),
    name: user.name,
    username: user.username || '',
    role: user.role || (user.isAdmin ? 'admin' : 'user'),
    plan: (user.plan || 'ghost').toLowerCase(),
    exp: user.planExpiresAt ? new Date(user.planExpiresAt).getTime() : null,
    lt: !!user.isLifetime,
    cr: user.sellerCredits || 0,
    iat: Date.now(),
  };
}

export function issueTicket(user: IUser): string {
  const { privateKey } = getKeyPair();
  const payload = buildPayload(user);
  const payloadJson = JSON.stringify(payload);
  const signature = crypto.sign(null, Buffer.from(payloadJson, 'ascii'), privateKey);
  return (
    Buffer.from(payloadJson, 'ascii').toString('base64url') + '.' + signature.toString('base64url')
  );
}

/** Serializa un usuario para el cliente Tauri, con su ticket de licencia nuevo. */
export function publicUser(user: IUser) {
  return {
    id: user._id,
    name: user.name,
    username: user.username,
    email: user.email,
    role: user.role || (user.isAdmin ? 'admin' : 'user'),
    isAdmin: user.isAdmin,
    plan: user.plan,
    isLifetime: user.isLifetime,
    planExpiresAt: user.planExpiresAt,
    sellerCredits: user.sellerCredits,
    ticket: issueTicket(user),
  };
}

/** Devuelve la clave pública en base64 para incrustarla en el cliente. */
export function publicKeyBase64(): string {
  const spki = getKeyPair().publicKey.export({ type: 'spki', format: 'der' });
  return spki.toString('base64');
}

export function verifyTicket(ticket: string, publicKeyB64?: string): TicketPayload | null {
  const dot = ticket.indexOf('.');
  if (dot === -1) return null;
  const payloadB64 = ticket.slice(0, dot);
  const sigB64 = ticket.slice(dot + 1);

  let payloadJson: string;
  let signature: Buffer;
  try {
    payloadJson = Buffer.from(payloadB64, 'base64url').toString('ascii');
    signature = Buffer.from(sigB64, 'base64url');
  } catch {
    return null;
  }

  const key = publicKeyB64
    ? crypto.createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), type: 'spki', format: 'der' })
    : getKeyPair().publicKey;

  const ok = crypto.verify(null, Buffer.from(payloadJson, 'ascii'), key, signature);
  if (!ok) return null;

  try {
    const payload = JSON.parse(payloadJson) as TicketPayload;
    if (payload.v !== TICKET_VERSION) return null;
    return payload;
  } catch {
    return null;
  }
}