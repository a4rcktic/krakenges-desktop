/**
 * Kraken Ges Zero-Knowledge 2FA (TOTP) Service
 * Implements RFC 6238 (Time-Based One-Time Password) using standard Web Crypto API.
 * Computes 6-digit TOTP codes locally on device with zero external dependencies.
 */

// Base32 RFC 4648 alphabet
const BASE32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Decodes a Base32 string into a Uint8Array.
 */
function base32ToUint8Array(base32: string): Uint8Array {
  const clean = base32.toUpperCase().replace(/[\s\-_=]/g, '');
  if (!clean) return new Uint8Array(0);

  let bits = 0;
  let value = 0;
  const output: number[] = [];

  for (let i = 0; i < clean.length; i++) {
    const idx = BASE32_CHARS.indexOf(clean[i]);
    if (idx === -1) continue; // Skip invalid characters gracefully

    value = (value << 5) | idx;
    bits += 5;

    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return new Uint8Array(output);
}

/**
 * Computes the HMAC-SHA1 digest for TOTP generation.
 */
async function hmacSha1(keyBytes: Uint8Array, counterBytes: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await window.crypto.subtle.importKey(
    'raw',
    keyBytes as unknown as BufferSource,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );

  const signature = await window.crypto.subtle.sign(
    'HMAC',
    cryptoKey,
    counterBytes as unknown as BufferSource
  );

  return new Uint8Array(signature);
}

export interface TOTPResult {
  code: string;
  remainingSeconds: number;
  period: number;
  valid: boolean;
}

/**
 * Generates a 6-digit TOTP code and countdown seconds for a given Base32 secret.
 */
export async function generateTOTP(secret: string, periodSeconds: number = 30): Promise<TOTPResult> {
  const sanitized = (secret || '').trim();
  if (!sanitized) {
    return { code: '------', remainingSeconds: 30, period: periodSeconds, valid: false };
  }

  try {
    const keyBytes = base32ToUint8Array(sanitized);
    if (keyBytes.length === 0) {
      return { code: '------', remainingSeconds: 30, period: periodSeconds, valid: false };
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const counter = Math.floor(nowSeconds / periodSeconds);
    const remainingSeconds = periodSeconds - (nowSeconds % periodSeconds);

    // Convert 64-bit integer counter to 8-byte big-endian buffer
    const counterBuffer = new ArrayBuffer(8);
    const counterView = new DataView(counterBuffer);
    counterView.setUint32(0, 0, false); // High 32 bits
    counterView.setUint32(4, counter, false); // Low 32 bits

    const hmacResult = await hmacSha1(keyBytes, new Uint8Array(counterBuffer));

    // Dynamic truncation per RFC 4226
    const offset = hmacResult[hmacResult.length - 1] & 0x0f;
    const binary =
      ((hmacResult[offset] & 0x7f) << 24) |
      ((hmacResult[offset + 1] & 0xff) << 16) |
      ((hmacResult[offset + 2] & 0xff) << 8) |
      (hmacResult[offset + 3] & 0xff);

    const otp = binary % 1000000;
    const code = otp.toString().padStart(6, '0');

    return {
      code,
      remainingSeconds,
      period: periodSeconds,
      valid: true,
    };
  } catch (err) {
    console.error('[TOTP] Error generating code:', err);
    return { code: '------', remainingSeconds: 30, period: periodSeconds, valid: false };
  }
}

/**
 * Validates whether a given string is a syntactically valid Base32 secret.
 */
export function isValidTOTPSecret(secret: string): boolean {
  const clean = (secret || '').toUpperCase().replace(/[\s\-_=]/g, '');
  if (clean.length < 8) return false;
  return /^[A-Z2-7]+$/.test(clean);
}
