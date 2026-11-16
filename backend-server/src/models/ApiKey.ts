import { model, Schema, Document, Types } from 'mongoose';
import crypto from 'crypto';

export interface IApiKey extends Document {
  userId: Types.ObjectId;
  name: string;
  /**
   * Valor almacenado. Las claves nuevas guardan `sha256:<hash>`; las antiguas
   * guardan la clave en claro hasta que se migran en su primer uso.
   */
  key: string;
  /** Hash SHA-256 de la clave, sin prefijo. */
  keyHash?: string;
  prefix: string;
  lastUsedAt?: Date;
  expiresAt?: Date;
  isActive: boolean;
  createdAt: Date;
}

/** Hash determinista de una API key. La clave en claro nunca se guarda. */
export function hashApiKey(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/** Valor que se guarda en el campo legacy `key` para que siga siendo único. */
export function storedApiKeyValue(hash: string): string {
  return `sha256:${hash}`;
}

function generateApiKey(): { key: string; prefix: string; keyHash: string } {
  const raw = `kgs_${crypto.randomBytes(32).toString('hex')}`;
  const prefix = raw.substring(0, 12);
  return { key: raw, prefix, keyHash: hashApiKey(raw) };
}

const ApiKeySchema = new Schema<IApiKey>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, required: true },
  // No se devuelve nunca por defecto. En claves nuevas contiene el hash, no la
  // clave; en las antiguas, la clave en claro hasta la migración.
  key: { type: String, required: true, unique: true, index: true, select: false },
  keyHash: { type: String, unique: true, sparse: true, index: true, select: false },
  prefix: { type: String, required: true },
  lastUsedAt: { type: Date },
  expiresAt: { type: Date },
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: () => new Date() },
});

ApiKeySchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.key;
    delete ret.keyHash;
  },
});

ApiKeySchema.statics.generateKey = function () {
  return generateApiKey();
};

export default model<IApiKey>('ApiKey', ApiKeySchema);
