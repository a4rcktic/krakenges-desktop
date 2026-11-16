import crypto from 'crypto';

/** Hash determinista de un refresh token. El token en claro nunca se guarda. */
export function hashRefreshToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/** Alias único que se guarda en la columna legacy `token`. */
export function storedRefreshTokenValue(hash: string): string {
  return `sha256:${hash}`;
}

/** Hash determinista de una API key. */
export function hashApiKey(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/** Alias único que se guarda en la columna legacy `key`. */
export function storedApiKeyValue(hash: string): string {
  return `sha256:${hash}`;
}

export function generateApiKey(): { key: string; prefix: string; keyHash: string } {
  // `gwt_` es el prefijo histórico de la app. Mantenerlo permite que las
  // integraciones existentes reconozcan las claves nuevas.
  const raw = `gwt_${crypto.randomBytes(32).toString('hex')}`;
  return {
    key: raw,
    prefix: raw.substring(0, 12),
    keyHash: hashApiKey(raw),
  };
}
