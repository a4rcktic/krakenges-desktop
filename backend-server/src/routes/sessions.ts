import { Router } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import Session from '../models/Session';
import Profile from '../models/Profile';
import User, { PLAN_LIMITS } from '../models/User';
import { authenticate } from '../authMiddleware';
import { logActivity } from '../services/activityLog';
import { asyncHandler } from '../utils/asyncHandler';

const router = Router();

const startSessionSchema = z.object({
  profileId: z.string().min(1),
});

router.get('/', authenticate, asyncHandler(async (req, res) => {
  try {
    const { status } = req.query;
    const filter: Record<string, unknown> = { userId: req.user!._id };

    if (status && typeof status === 'string' && ['active', 'stopped'].includes(status)) {
      filter.status = status;
    }

    const sessions = await Session.find(filter)
      .populate('profileId')
      .sort({ createdAt: -1 })
      .limit(100);

    res.json(sessions);
  } catch (e) {
    res.status(500).json({ error: 'Error cargando sesiones' });
  }
}));

const startHandler = async (req: any, res: any) => {
  try {
    const parsed = startSessionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }

    // Sin esta comprobación, Profile.findById('cualquier cosa') lanzaba un
    // CastError de Mongoose que el catch exterior convertía en un 500: culpa al
    // servidor de una petición del cliente mal formada. Se probó con un test.
    if (!mongoose.isValidObjectId(parsed.data.profileId)) {
      return res.status(400).json({ error: 'profileId inválido' });
    }

    const user = await User.findById(req.user!._id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const limits = PLAN_LIMITS[user.plan];
    if (limits.maxSessions !== -1) {
      const activeCount = await Session.countDocuments({ userId: req.user!._id, status: 'active' });
      if (activeCount >= limits.maxSessions) {
        return res.status(403).json({
          error: `Límite de sesiones activas alcanzado (${limits.maxSessions}) para tu plan ${user.plan}.`,
          code: 'PLAN_LIMIT_REACHED',
          limit: limits.maxSessions,
          current: activeCount,
        });
      }
    }

    const profile = await Profile.findById(parsed.data.profileId);
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }
    if (!profile.userId.equals(req.user!._id)) {
      return res.status(403).json({ error: 'Profile belongs to another user' });
    }

    const session = await Session.create({
      userId: req.user!._id,
      profileId: profile._id,
      status: 'active',
      startedAt: new Date(),
    });

    await logActivity(req.user!._id, 'start', 'session', session._id.toString(), { profileName: profile.name }, req.ip);

    res.status(201).json(session);
  } catch (e) {
    res.status(500).json({ error: 'Error iniciando sesion' });
  }
};

router.post('/start', authenticate, startHandler);
router.post('/', authenticate, startHandler);

router.post('/:id/stop', authenticate, asyncHandler(async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid session id' });
    }

    const session = await Session.findById(req.params.id);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    if (!session.userId.equals(req.user!._id)) {
      return res.status(403).json({ error: 'Session belongs to another user' });
    }
    if (session.status === 'stopped') {
      return res.status(400).json({ error: 'Session already stopped' });
    }

    const now = new Date();
    const duration = Math.round((now.getTime() - session.startedAt.getTime()) / 60000);

    session.status = 'stopped';
    session.stoppedAt = now;
    session.duration = duration;
    await session.save();

    await logActivity(req.user!._id, 'stop', 'session', session._id.toString(), { duration }, req.ip);

    res.json(session);
  } catch (e) {
    res.status(500).json({ error: 'Error deteniendo sesion' });
  }
}));

router.post('/:id/reactivate', authenticate, asyncHandler(async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid session id' });
    }

    const session = await Session.findById(req.params.id);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    if (!session.userId.equals(req.user!._id)) {
      return res.status(403).json({ error: 'Session belongs to another user' });
    }

    session.status = 'active';
    session.startedAt = new Date();
    session.stoppedAt = undefined;
    session.duration = undefined;
    await session.save();

    await logActivity(req.user!._id, 'reactivate', 'session', session._id.toString(), undefined, req.ip);

    res.json(session);
  } catch (e) {
    res.status(500).json({ error: 'Error reactivando sesion' });
  }
}));

router.delete('/:id', authenticate, asyncHandler(async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid session id' });
    }

    const session = await Session.findById(req.params.id);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    if (!session.userId.equals(req.user!._id)) {
      return res.status(403).json({ error: 'Session belongs to another user' });
    }

    await session.deleteOne();

    await logActivity(req.user!._id, 'delete', 'session', req.params.id, undefined, req.ip);

    res.json({ message: 'Sesion eliminada.' });
  } catch (e) {
    res.status(500).json({ error: 'Error eliminando sesion' });
  }
}));

export default router;
