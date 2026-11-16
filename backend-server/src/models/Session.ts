import { model, Schema, Document, Types } from 'mongoose';

export interface ISession extends Document {
  userId: Types.ObjectId;
  profileId: Types.ObjectId;
  status: 'active' | 'stopped';
  startedAt: Date;
  stoppedAt?: Date;
  duration?: number;
  createdAt: Date;
}

const SessionSchema = new Schema<ISession>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  profileId: { type: Schema.Types.ObjectId, ref: 'Profile', required: true, index: true },
  status: { type: String, enum: ['active', 'stopped'], default: 'active', index: true },
  startedAt: { type: Date, default: () => new Date() },
  stoppedAt: { type: Date },
  duration: { type: Number },
  createdAt: { type: Date, default: () => new Date() },
});

SessionSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
  },
});

export default model<ISession>('Session', SessionSchema);
