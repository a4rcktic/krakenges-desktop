import { describe, expect, it } from 'vitest';
import { isPrivateAddress, validateProxy } from '../services/proxyValidator';

describe('proxyValidator SSRF guard', () => {
  it('clasifica direcciones privadas y reservadas', () => {
    for (const address of [
      '127.0.0.1',
      '10.0.0.1',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '::1',
      'fc00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }

    for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });

  it('rechaza un proxy loopback sin abrir la conexión', async () => {
    const result = await validateProxy('http://127.0.0.1:8080');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/privada|reservada/i);
  });

  it('rechaza el endpoint de metadatos', async () => {
    const result = await validateProxy('http://169.254.169.254');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/privada|reservada/i);
  });
});
