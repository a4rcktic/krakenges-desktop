import { model, Schema, Document, Types } from 'mongoose';
import crypto from 'crypto';

export interface IRefreshToken extends Document {
  userId: Types.ObjectId;
  /**
   * Valor almacenado. Los tokens nuevos guardan `sha256:<hash>`; los antiguos
   * guardan el token en claro hasta que se migran en su primer uso.
   */
  token: string;
  /** Hash SHA-256 del token, sin prefijo. */
  tokenHash?: string;
  expiresAt: Date;
  createdAt: Date;
}

/** Hash determinista de un refresh token. El token en claro nunca se guarda. */
export function hashRefreshToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/** Valor que se guarda en el campo legacy `token` para que siga siendo único. */
export function storedRefreshTokenValue(hash: string): string {
  return `sha256:${hash}`;
}

const RefreshTokenSchema = new Schema<IRefreshToken>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  token: { type: String, required: true, unique: true, index: true, select: false },
  tokenHash: { type: String, unique: true, sparse: true, index: true, select: false },
  expiresAt: { type: Date, required: true, index: true },
  createdAt: { type: Date, default: () => new Date() },
});

RefreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

RefreshTokenSchema.set('toJSON', {
  versionKey: false,
  transform: (_doc, ret) => {
    delete ret.token;
    delete ret.tokenHash;
    return ret;
  },
});

export default model<IRefreshToken>('RefreshToken', RefreshTokenSchema);
