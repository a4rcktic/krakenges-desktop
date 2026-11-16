import { model, Schema, Document, Types } from 'mongoose';

export interface IProfile extends Document {
  userId: Types.ObjectId;
  name: string;
  proxy?: string;
  startUrl?: string;
  tags: string[];
  notes?: string;
  /**
   * Sistema operativo que ANUNCIARA el perfil. Es la fuente de verdad de la
   * identidad: mientras esta vacio, el servidor sortea uno (autoOs) y lo fija
   * aqui en la primera peticion de huella. Despues ya no cambia solo.
   *
   * Antes no existia este campo y el sortea era la unica fuente, asi que el
   * backend podia devolver macOS a un usuario en Linux. Un perfil que dice
   * "Macintosh" con un motor Chrome sobre Linux se contradice a si mismo, que
   * es justo lo que delata un emulador.
   */
  os?: 'windows' | 'macos' | 'linux' | 'android' | 'ios';
  createdAt: Date;
  updatedAt: Date;
}

const ProfileSchema = new Schema<IProfile>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, required: true },
  proxy: { type: String },
  startUrl: { type: String },
  tags: [{ type: String, index: true }],
  notes: { type: String },
  // Sin default a proposito: undefined significa "aun no decidido", que es
  // distinto de haber decidido. Con default, los 675 perfiles ya guardados en
  // produccion aparecerian como si hubieran elegido algo.
  os: { type: String, enum: ['windows', 'macos', 'linux', 'android', 'ios'] },
  createdAt: { type: Date, default: () => new Date() },
  updatedAt: { type: Date, default: () => new Date() },
});

ProfileSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
  },
});

ProfileSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

export default model<IProfile>('Profile', ProfileSchema);
