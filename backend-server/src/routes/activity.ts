import { Router } from 'express';
import { authenticate } from '../authMiddleware';
import ActivityLog from '../models/ActivityLog';
import { asyncHandler, HttpError } from '../utils/asyncHandler';

const router = Router();

/**
 * Rango de fechas válido, o null si no se pidió.
 *
 * Antes se hacía `new Date(from)` sin comprobar nada. Con un `?from=basura`
 * sale un Invalid Date, que Mongoose intenta castear al castear la query y
 * revienta con un error 500 que no explica el motivo. Ahora se rechaza con un
 * 400 que dice qué hacer.
 */
function dateRange(from: unknown, to: unknown): { $gte?: Date; $lte?: Date } | null {
  if (from === undefined && to === undefined) return null;

  const range: { $gte?: Date; $lte?: Date } = {};

  if (from !== undefined) {
    const d = new Date(String(from));
    if (Number.isNaN(d.getTime())) {
      throw new HttpError(400, `El parámetro "from" no es una fecha válida: ${from}`);
    }
    range.$gte = d;
  }
  if (to !== undefined) {
    const d = new Date(String(to));
    if (Number.isNaN(d.getTime())) {
      throw new HttpError(400, `El parámetro "to" no es una fecha válida: ${to}`);
    }
    range.$lte = d;
  }
  return range;
}

/**
 * Límite de resultados acotado a 1..500.
 *
 * El `Math.min(parseInt(limit) || 100, 500)` anterior no acotaba por abajo: un
 * `?limit=-5` pasaba el -5 intacto a Mongoose. Y `?limit=abc` caía al 100 por
 * el `|| 100`, lo que además convertía un 0 en 100.
 */
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

router.get('/', authenticate, asyncHandler(async (req, res) => {
  const { action, entity, from, to, limit } = req.query;
  const filter: Record<string, unknown> = { userId: req.user!._id };

  if (action !== undefined && typeof action !== 'string') {
    throw new HttpError(400, 'El parámetro "action" debe ser texto.');
  }
  if (entity !== undefined && typeof entity !== 'string') {
    throw new HttpError(400, 'El parámetro "entity" debe ser texto.');
  }
  if (action) filter.action = action;
  if (entity) filter.entity = entity;

  const range = dateRange(from, to);
  if (range) filter.createdAt = range;

  const logs = await ActivityLog.find(filter)
    .sort({ createdAt: -1 })
    .limit(parseLimit(limit));

  res.json(logs);
}));

router.get('/actions', authenticate, asyncHandler(async (_req, res) => {
  const actions = await ActivityLog.distinct('action', { userId: _req.user!._id });
  res.json(actions);
}));

export default router;
