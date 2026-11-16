import jwt, { SignOptions } from 'jsonwebtoken';

/**
 * `purpose` del token que emite /login cuando la cuenta tiene 2FA. Se firma con
 * el mismo secreto que el access token, así que `authenticate` debe rechazar
 * cualquier token que lleve `purpose`: si no, el token pre-2FA abriría la API
 * sin el segundo factor.
 */
export const PRE_AUTH_PURPOSE = '2fa-pending';

export function signJwt(payload: object, secret: string, options: { expiresIn?: string | number }) {
  return jwt.sign(payload, secret, options as SignOptions);
}
