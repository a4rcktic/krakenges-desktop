import ActivityLog from '../models/ActivityLog';
import { Types } from 'mongoose';

export async function logActivity(
  userId: Types.ObjectId | string,
  action: string,
  entity: string,
  entityId?: string,
  details?: Record<string, unknown>,
  ip?: string,
): Promise<void> {
  await ActivityLog.create({
    userId,
    action,
    entity,
    entityId,
    details,
    ip,
  });
}
