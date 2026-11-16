import { Router } from 'express';
import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { activityLogs } from '../db/schema';
import { dbOf } from '../db/context';
import { authenticate } from '../middleware/auth';
import { asyncHandler } from '../utils/asyncHandler';
import { HttpError } from '../errors';
import { omitNullish } from '../utils/omitNullish';

const router = Router();

function dateRange(
  from: unknown,
  to: unknown,
): { from?: Date; to?: Date } | null {
  if (from === undefined && to === undefined) return null;

  const range: { from?: Date; to?: Date } = {};
  if (from !== undefined) {
    const d = new Date(String(from));
    if (Number.isNaN(d.getTime())) {
      throw new HttpError(400, `El parámetro "from" no es una fecha válida: ${from}`);
    }
    range.from = d;
  }
  if (to !== undefined) {
    const d = new Date(String(to));
    if (Number.isNaN(d.getTime())) {
      throw new HttpError(400, `El parámetro "to" no es una fecha válida: ${to}`);
    }
    range.to = d;
  }
  return range;
}

function parseLimit(limit: unknown, defaultValue = 100): number {
  if (limit === undefined) return defaultValue;
  const n = Number(limit);
  if (!Number.isFinite(n) || Number.isNaN(n)) {
    throw new HttpError(400, `El parámetro "limit" debe ser un número: ${limit}`);
  }
  const int = Math.trunc(n);
  if (int < 1) return 1;
  return Math.min(int, 500);
}

router.get(
  '/',
  authenticate,
  asyncHandler(async (req, res) => {
    const { action, entity, from, to, limit } = req.query;

    if (action !== undefined && typeof action !== 'string') {
      throw new HttpError(400, 'El parámetro "action" debe ser texto.');
    }
    if (entity !== undefined && typeof entity !== 'string') {
      throw new HttpError(400, 'El parámetro "entity" debe ser texto.');
    }

    const conditions = [eq(activityLogs.userId, req.user!.id)];
    if (action) conditions.push(eq(activityLogs.action, action));
    if (entity) conditions.push(eq(activityLogs.entity, entity));

    const range = dateRange(from, to);
    if (range?.from) conditions.push(gte(activityLogs.createdAt, range.from));
    if (range?.to) conditions.push(lte(activityLogs.createdAt, range.to));

    const db = dbOf(req);
    const logs = await db
      .select()
      .from(activityLogs)
      .where(and(...conditions))
      .orderBy(desc(activityLogs.createdAt))
      .limit(parseLimit(limit));

    res.json(
      logs.map((log) =>
        omitNullish({ ...log }, ['entityId', 'details', 'ip']),
      ),
    );
  }),
);

router.get(
  '/actions',
  authenticate,
  asyncHandler(async (req, res) => {
    const db = dbOf(req);
    const rows = await db
      .selectDistinct({ action: activityLogs.action })
      .from(activityLogs)
      .where(eq(activityLogs.userId, req.user!.id));
    res.json(rows.map((r) => r.action));
  }),
);

export default router;
