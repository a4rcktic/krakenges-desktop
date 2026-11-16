import speakeasy from 'speakeasy';
import qrcode from 'qrcode';
import { BRAND_NAME } from '../config/brand';

export function generateTwoFactorSecret(): { secret: string; otpauthUrl: string } {
  const secret = speakeasy.generateSecret({
    name: BRAND_NAME,
    issuer: BRAND_NAME,
    length: 32,
  });

  return {
    secret: secret.base32 || '',
    otpauthUrl: secret.otpauth_url || '',
  };
}

export function verifyTwoFactorToken(secret: string, token: string): boolean {
  return speakeasy.totp.verify({
    secret,
    encoding: 'base32',
    token,
    window: 2,
  });
}

export async function generateQrCode(otpauthUrl: string): Promise<string> {
  return qrcode.toDataURL(otpauthUrl);
}
