import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import type { UserRow } from '../db/schema';
import {
  getEffectiveLimits,
  getEffectivePlanName,
  type PlanLimits,
} from '../config/plans';
import { omitNullish } from '../utils/omitNullish';

/**
 * Tickets de licencia firmados con Ed25519.
 *
 * Formato: base64url(payloadJson) + '.' + base64url(signature).
 * La clave pública se incrusta en el cliente Tauri; el servidor solo firma.
 */

export const TICKET_VERSION = 1;
export const KEY_VERSION = 1;

export interface TicketPayload {
  v: number;
  kid: number;
  sub: string;
  name: string;
  username: string;
  role: string;
  plan: string;
  // Campos nuevos: los clientes antiguos los ignoran. Permiten que la UI
  // muestre el nombre y los límites exactos de una licencia personalizada.
  planName: string;
  limits: PlanLimits;
  exp: number | null;
  lt: boolean;
  cr: number;
  iat: number;
}

type KeyPair = { publicKey: crypto.KeyObject; privateKey: crypto.KeyObject };

function loadOrCreateKeyPair(): KeyPair {
  const envPriv =
    process.env.KRAKENGES_LICENSE_PRIVATE_KEY ||
    process.env.MASKOS_LICENSE_PRIVATE_KEY;
  if (envPriv) {
    const privateKey = crypto.createPrivateKey({
      key: Buffer.from(envPriv, 'base64'),
      type: 'pkcs8',
      format: 'der',
    });
    return { publicKey: crypto.createPublicKey(privateKey), privateKey };
  }

  const privPath = path.join(config.licenseKeysDir, 'license_ed25519.pem');
  const pubPath = path.join(config.licenseKeysDir, 'license_ed25519_pub.pem');

  // En producción NUNCA se genera un par nuevo de forma silenciosa: eso
  // invalidaría todos los tickets y las claves públicas compiladas en el
  // cliente. Si faltan los ficheros, el servicio debe fallar al arrancar.
  if (
    config.isProduction &&
    (!fs.existsSync(privPath) || !fs.existsSync(pubPath))
  ) {
    throw new Error(
      `Faltan las claves de licencia Ed25519 en ${config.licenseKeysDir}. ` +
        'Copia el par de producción o define KRAKENGES_LICENSE_PRIVATE_KEY (o MASKOS_LICENSE_PRIVATE_KEY).',
    );
  }

  if (!fs.existsSync(config.licenseKeysDir)) {
    fs.mkdirSync(config.licenseKeysDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(config.licenseKeysDir, 0o700);
  }

  if (!fs.existsSync(privPath) || !fs.existsSync(pubPath)) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(privPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), {
      mode: 0o600,
    });
    fs.writeFileSync(pubPath, publicKey.export({ type: 'spki', format: 'pem' }), {
      mode: 0o644,
    });
    return { publicKey, privateKey };
  }

  return {
    privateKey: crypto.createPrivateKey(fs.readFileSync(privPath)),
    publicKey: crypto.createPublicKey(fs.readFileSync(pubPath)),
  };
}

let cachedPair: KeyPair | null = null;

export function getKeyPair(): KeyPair {
  if (!cachedPair) cachedPair = loadOrCreateKeyPair();
  return cachedPair;
}

export function publicKeyPem(): string {
  return getKeyPair().publicKey.export({ type: 'spki', format: 'pem' }).toString();
}

function buildPayload(user: UserRow): TicketPayload {
  return {
    v: TICKET_VERSION,
    kid: KEY_VERSION,
    sub: user.id,
    name: user.name,
    username: user.username || '',
    role: user.role || (user.isAdmin ? 'admin' : 'user'),
    plan: (user.plan || 'ghost').toLowerCase(),
    planName: getEffectivePlanName(user),
    limits: getEffectiveLimits(user),
    exp: user.planExpiresAt ? new Date(user.planExpiresAt).getTime() : null,
    lt: Boolean(user.isLifetime),
    cr: user.sellerCredits || 0,
    iat: Date.now(),
  };
}

export function issueTicket(user: UserRow): string {
  const { privateKey } = getKeyPair();
  const payloadJson = JSON.stringify(buildPayload(user));
  const signature = crypto.sign(null, Buffer.from(payloadJson, 'ascii'), privateKey);
  return (
    Buffer.from(payloadJson, 'ascii').toString('base64url') +
    '.' +
    signature.toString('base64url')
  );
}

export function publicUser(user: UserRow) {
  return omitNullish(
    {
      id: user.id,
      name: user.name,
      username: user.username,
      email: user.email,
      role: user.role || (user.isAdmin ? 'admin' : 'user'),
      isAdmin: user.isAdmin,
      plan: user.plan,
      planName: getEffectivePlanName(user),
      limits: getEffectiveLimits(user),
      isLifetime: user.isLifetime,
      planExpiresAt: user.planExpiresAt,
      sellerCredits: user.sellerCredits,
      ticket: issueTicket(user),
    },
    ['username', 'email'],
  );
}

/**
 * Serializa el usuario para /users/me sin campos sensibles.
 *
 * `updatedAt` no existía en el modelo Mongo y no forma parte del contrato.
 * Los campos opcionales sin valor se omiten, como hacía Mongoose.
 */
export function safeUserJson(user: UserRow) {
  return omitNullish(
    {
      id: user.id,
      name: user.name,
      username: user.username,
      email: user.email,
      role: user.role || (user.isAdmin ? 'admin' : 'user'),
      isAdmin: user.isAdmin,
      banned: user.banned,
      plan: user.plan,
      planName: getEffectivePlanName(user),
      limits: getEffectiveLimits(user),
      sellerCredits: user.sellerCredits,
      devices: user.devices,
      deviceHwid: user.deviceHwid,
      planUpgradedAt: user.planUpgradedAt,
      planExpiresAt: user.planExpiresAt,
      isLifetime: user.isLifetime,
      lastLoginAt: user.lastLoginAt,
      twoFactorEnabled: user.twoFactorEnabled,
      createdAt: user.createdAt,
    },
    ['username', 'email', 'planUpgradedAt', 'lastLoginAt'],
  );
}

export function publicKeyBase64(): string {
  const spki = getKeyPair().publicKey.export({ type: 'spki', format: 'der' });
  return spki.toString('base64');
}

export function verifyTicket(ticket: string, publicKeyB64?: string): TicketPayload | null {
  const dot = ticket.indexOf('.');
  if (dot === -1) return null;

  try {
    const payloadJson = Buffer.from(ticket.slice(0, dot), 'base64url').toString('ascii');
    const signature = Buffer.from(ticket.slice(dot + 1), 'base64url');
    const key = publicKeyB64
      ? crypto.createPublicKey({
          key: Buffer.from(publicKeyB64, 'base64'),
          type: 'spki',
          format: 'der',
        })
      : getKeyPair().publicKey;

    if (!crypto.verify(null, Buffer.from(payloadJson, 'ascii'), key, signature)) {
      return null;
    }

    const payload = JSON.parse(payloadJson) as TicketPayload;
    return payload.v === TICKET_VERSION ? payload : null;
  } catch {
    return null;
  }
}
