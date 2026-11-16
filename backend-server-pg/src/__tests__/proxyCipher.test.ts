import crypto from 'crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  decryptProxy,
  encryptProxy,
  isEncrypted,
} from '../services/proxyCipher';

const KEY = 'b64:' + crypto.randomBytes(32).toString('base64');

function encryptWithPrefix(plain: string, key: Buffer, prefix: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${prefix}${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${data.toString('base64')}`;
}

describe('proxyCipher', () => {
  const originalMaskos = process.env.MASKOS_PROXY_ENCRYPTION_KEY;
  const originalKrakenges = process.env.KRAKENGES_PROXY_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.MASKOS_PROXY_ENCRYPTION_KEY = KEY;
    delete process.env.KRAKENGES_PROXY_ENCRYPTION_KEY;
  });

  afterEach(() => {
    if (originalMaskos === undefined) delete process.env.MASKOS_PROXY_ENCRYPTION_KEY;
    else process.env.MASKOS_PROXY_ENCRYPTION_KEY = originalMaskos;

    if (originalKrakenges === undefined) delete process.env.KRAKENGES_PROXY_ENCRYPTION_KEY;
    else process.env.KRAKENGES_PROXY_ENCRYPTION_KEY = originalKrakenges;
  });

  it('escribe el prefijo nuevo y puede descifrar el prefijo maskos del backend Mongo', () => {
    const encrypted = encryptProxy('http://user:pass@proxy.example:8080');
    expect(encrypted).toMatch(/^krakenges:v1:/);
    expect(isEncrypted(encrypted)).toBe(true);
    expect(decryptProxy(encrypted)).toBe('http://user:pass@proxy.example:8080');
  });

  it('descifra tokens legacy con prefijo krakenges:v1:', () => {
    const key = Buffer.from(KEY.slice(4), 'base64');
    const legacy = encryptWithPrefix(
      'http://legacy:secret@proxy.example:3128',
      key,
      'krakenges:v1:',
    );

    expect(isEncrypted(legacy)).toBe(true);
    expect(decryptProxy(legacy)).toBe('http://legacy:secret@proxy.example:3128');
  });

  it('descifra tokens intermedios con prefijo maskos:v1:', () => {
    const key = Buffer.from(KEY.slice(4), 'base64');
    const intermediate = encryptWithPrefix(
      'http://maskos:secret@proxy.example:3128',
      key,
      'maskos:v1:',
    );

    expect(isEncrypted(intermediate)).toBe(true);
    expect(decryptProxy(intermediate)).toBe('http://maskos:secret@proxy.example:3128');
  });

  it('devuelve el texto plano legacy sin intentar descifrarlo', () => {
    expect(decryptProxy('http://plain:pass@proxy.example:8080')).toBe(
      'http://plain:pass@proxy.example:8080',
    );
    expect(isEncrypted('http://plain:pass@proxy.example:8080')).toBe(false);
  });

  it('devuelve undefined si la clave no corresponde', () => {
    const encrypted = encryptProxy('http://user:pass@proxy.example:8080');
    process.env.MASKOS_PROXY_ENCRYPTION_KEY = 'otra-clave';
    expect(decryptProxy(encrypted)).toBeUndefined();
  });
});
