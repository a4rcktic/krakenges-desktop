import { model, Schema, Document, Types } from 'mongoose';
import { PlanType } from '../config/plans';
import { UserRole } from './User';

export type KeyStatus = 'active' | 'redeemed' | 'revoked' | 'expired';

export interface ILicenseKey extends Document {
  _id: Types.ObjectId;
  key: string;
  plan: 'shadow' | 'specter' | 'phantom';
  durationDays: number; // 30, 90, 365, or -1 (lifetime)
  role: 'user' | 'seller' | 'admin';
  status: KeyStatus;
  isActive: boolean; // Kept for legacy compatibility
  createdBy?: Types.ObjectId;
  redeemedBy?: Types.ObjectId;
  redeemedAt?: Date;
  tag?: string;
  expiresAt?: Date; // Expiration deadline to activate/redeem the key
  createdAt: Date;
}

const LicenseKeySchema = new Schema<ILicenseKey>({
  key: { type: String, required: true, unique: true, index: true },
  plan: {
    type: String,
    enum: ['ghost', 'shadow', 'specter', 'phantom', 'pro', 'enterprise'],
    default: 'shadow',
    required: true,
  },
  durationDays: { type: Number, default: 30, required: true },
  role: { type: String, enum: ['user', 'seller', 'admin'], default: 'user' },
  status: {
    type: String,
    enum: ['active', 'redeemed', 'revoked', 'expired'],
    default: 'active',
    index: true,
  },
  isActive: { type: Boolean, default: true },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  redeemedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  redeemedAt: { type: Date },
  tag: { type: String, maxlength: 100 },
  expiresAt: { type: Date },
  createdAt: { type: Date, default: () => new Date() },
});

LicenseKeySchema.pre('save', function (this: ILicenseKey, next) {
  // Sync isActive with status
  if (this.isModified('status')) {
    this.isActive = this.status === 'active';
  } else if (this.isModified('isActive')) {
    this.status = this.isActive ? 'active' : 'revoked';
  }
  next();
});

LicenseKeySchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
  },
});

export default model<ILicenseKey>('LicenseKey', LicenseKeySchema);
