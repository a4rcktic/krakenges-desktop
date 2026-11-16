import { activityLogs } from '../db/schema';
import type { Database } from '../db/client';

export async function logActivity(
  db: Database,
  userId: string | null | undefined,
  action: string,
  entity: string,
  entityId?: string | null,
  details?: Record<string, unknown> | null,
  ip?: string | null,
): Promise<void> {
  await db.insert(activityLogs).values({
    userId: userId ?? null,
    action,
    entity,
    entityId: entityId ?? null,
    details: details ?? null,
    ip: ip ?? null,
  });
}
