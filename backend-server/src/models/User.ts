import { model, Schema, Document, Types } from 'mongoose';
import { PlanType, PLAN_LIMITS } from '../config/plans';

export { PlanType, PLAN_LIMITS };

export type UserRole = 'owner' | 'admin' | 'seller' | 'user';

export interface IUser extends Document {
  _id: Types.ObjectId;
  name: string;
  username?: string;
  email?: string;
  passwordHash: string;
  role: UserRole;
  isAdmin: boolean;
  banned: boolean;
  plan: PlanType;
  sellerCredits?: number; // Credits to generate license keys for sellers
  /**
   * Dispositivos desde los que se ha iniciado sesión con esta cuenta.
   *
   * Antes esto era un único `deviceHwid: string`, y un segundo dispositivo
   * recibía un 403 ("vinculada a otro dispositivo físico"). Eso hacía imposible
   * el uso normal de un producto multiplataforma: la misma persona que compra
   * con una key no podía abrir Kraken Ges en Windows, en Linux y en Android.
   *
   * AHORA SOLO SE REGISTRA, NO SE BLOQUEA. La lista sirve para que el usuario
   * vea en qué equipos está activa su cuenta y para que soporte pueda cerrar
   * sesiones concretas. El límite de dispositivos y la verificación fuerte de
   * HWID se implementarán más adelante; hasta entonces el acceso es libre.
   */
  devices?: IDevice[];
  /** HWID único de las cuentas anteriores a la lista. Se conserva y se migra. */
  deviceHwid?: string;
  planUpgradedAt?: Date;
  planExpiresAt?: Date | null;
  isLifetime?: boolean;
  lastLoginAt?: Date;
  twoFactorEnabled: boolean;
  twoFactorSecret?: string;
  passwordResetToken?: string;
  passwordResetExpires?: Date;
  /**
   * Momento del último cambio de contraseña. Los JWT emitidos antes de esta
   * fecha se rechazan, así que cambiar la contraseña cierra también las
   * sesiones que aún tuvieran un access token válido.
   */
  passwordChangedAt?: Date;
  createdAt: Date;
}

/**
 * Un equipo desde el que se ha iniciado sesion con la cuenta.
 *
 * Todavia NO se usa para bloquear (no hay limite de dispositivos): sirve para
 * que el usuario y soporte vean en que equipos esta activa la cuenta. El
 * bloqueo por HWID se reimplementara mas adelante.
 */
export interface IDevice {
  hwid: string;
  /** 'windows' | 'linux' | 'macos' | 'android' | 'ios' | 'unknown' */
  platform: string;
  /** Nombre legible del equipo, para que el usuario lo reconozca. */
  label?: string;
  firstSeen: Date;
  lastSeen: Date;
}

/** Sub-esquema de un dispositivo registrado. */
const DeviceSchema = new Schema<IDevice>({
  hwid: { type: String, required: true },
  platform: { type: String, default: 'unknown' },
  label: { type: String, default: '' },
  firstSeen: { type: Date, default: Date.now },
  lastSeen: { type: Date, default: Date.now },
});

const UserSchema = new Schema<IUser>({
  name: { type: String, required: true },
  username: { type: String, unique: true, sparse: true, minlength: 3, maxlength: 30 },
  email: { type: String, unique: true, sparse: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ['owner', 'admin', 'seller', 'user'], default: 'user' },
  isAdmin: { type: Boolean, default: false },
  banned: { type: Boolean, default: false },
  plan: {
    type: String,
    enum: ['ghost', 'shadow', 'specter', 'phantom', 'free', 'pro', 'enterprise'],
    default: 'ghost',
  },
  sellerCredits: { type: Number, default: 0 },
  // Dispositivos donde se ha iniciado sesion. Se registran, no se bloquean:
  // una key debe servir en Windows, Linux y Android a la vez.
  devices: { type: [DeviceSchema], default: [] },
  deviceHwid: { type: String, default: null },
  planUpgradedAt: { type: Date },
  planExpiresAt: { type: Date, default: null },
  isLifetime: { type: Boolean, default: false },
  lastLoginAt: { type: Date },
  twoFactorEnabled: { type: Boolean, default: false },
  twoFactorSecret: { type: String },
  passwordResetToken: { type: String },
  passwordResetExpires: { type: Date },
  passwordChangedAt: { type: Date },
  createdAt: { type: Date, default: () => new Date() },
});

UserSchema.pre('save', function (next) {
  // Synchronize isAdmin with role: true if owner or admin
  if (this.isModified('role')) {
    this.isAdmin = this.role === 'owner' || this.role === 'admin';
  } else if (this.isModified('isAdmin') && this.isAdmin && this.role === 'user') {
    this.role = 'admin';
  }
  next();
});

UserSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.passwordHash;
    delete ret.twoFactorSecret;
    delete ret.passwordResetToken;
    delete ret.passwordResetExpires;
    delete ret.passwordChangedAt;
  },
});

export default model<IUser>('User', UserSchema);
