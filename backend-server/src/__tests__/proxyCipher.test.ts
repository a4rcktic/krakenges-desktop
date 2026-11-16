import crypto from 'crypto';
import { encryptProxy, decryptProxy, isEncrypted } from '../services/proxyCipher';

describe('proxyCipher', () => {
  beforeEach(() => {
    delete process.env.KRAKENGES_PROXY_ENCRYPTION_KEY;
    delete process.env.SESSION_SECRET;
    delete process.env.JWT_SECRET;
  });

  it('redondea cifrado/descifrado con el valor original', () => {
    process.env.KRAKENGES_PROXY_ENCRYPTION_KEY = 'b64:' + crypto.randomBytes(32).toString('base64');
    const proxy = 'pr.oxylabs.io:7777:user123:pw:with:colons';
    const stored = encryptProxy(proxy);
    expect(stored).toBeTruthy();
    expect(stored).toMatch(/^krakenges:v1:/);
    expect(stored).not.toContain('oxylabs');
    expect(isEncrypted(stored)).toBe(true);
    expect(decryptProxy(stored)).toBe(proxy);
  });

  it('genera tokens distintos en cada llamada (IV aleatorio)', () => {
    process.env.KRAKENGES_PROXY_ENCRYPTION_KEY = 'b64:' + crypto.randomBytes(32).toString('base64');
    const stored1 = encryptProxy('host:8080:user:pass');
    const stored2 = encryptProxy('host:8080:user:pass');
    expect(stored1).not.toBe(stored2);
    expect(decryptProxy(stored1)).toBe('host:8080:user:pass');
    expect(decryptProxy(stored2)).toBe('host:8080:user:pass');
  });

  it('deja pasar valores legacy en texto plano', () => {
    process.env.KRAKENGES_PROXY_ENCRYPTION_KEY = 'b64:' + crypto.randomBytes(32).toString('base64');
    expect(decryptProxy('host:8080:user:pass')).toBe('host:8080:user:pass');
    expect(isEncrypted('host:8080:user:pass')).toBe(false);
    expect(encryptProxy('host:8080:user:pass')).toMatch(/^krakenges:v1:/);
    expect(decryptProxy(undefined)).toBeUndefined();
    expect(decryptProxy(null)).toBeNull();
  });

  it('falla ruidosamente si no hay ninguna clave configurada', () => {
    // Regresión: antes caía en la constante pública 'krakenges-proxy-dev-secret'.
    expect(() => encryptProxy('host:8080:user:pass')).toThrow(/Falta la clave de cifrado/);
  });

  it('devuelve undefined si la clave no puede descifrar el token', () => {
    const keyA = 'b64:' + crypto.randomBytes(32).toString('base64');
    const keyB = 'b64:' + crypto.randomBytes(32).toString('base64');
    process.env.KRAKENGES_PROXY_ENCRYPTION_KEY = keyA;
    const stored = encryptProxy('user:pass@host:8080')!;
    process.env.KRAKENGES_PROXY_ENCRYPTION_KEY = keyB;
    expect(decryptProxy(stored)).toBeUndefined();
    const corrupted = stored.split(':').slice(0, -1).join(':') + ':AAAA';
    expect(decryptProxy(corrupted)).toBeUndefined();
  });

  it('deriva clave estable desde SESSION_SECRET si no hay clave propia', () => {
    const proxy = 'isp.provider:9999:u:p';
    process.env.SESSION_SECRET = 'mi-clave-base';
    const a = encryptProxy(proxy);
    const b = encryptProxy(proxy);
    expect(decryptProxy(a)).toBe(proxy);
    expect(decryptProxy(b)).toBe(proxy);
  });
});