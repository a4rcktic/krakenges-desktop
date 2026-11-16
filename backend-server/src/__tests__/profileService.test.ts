import mongoose from 'mongoose';
import Profile from '../models/Profile';
import User, { PLAN_LIMITS } from '../models/User';
import { checkProfileQuota, isValidObjectId } from '../services/profileService';

/**
 * Tests de la regla de cuotas.
 *
 * Esta es la razón de existir del servicio: la regla del plan estaba duplicada
 * en POST / y POST /bulk con dos comparaciones distintas, y no se podía
 * testear sin levantar HTTP y fabricar un JWT.
 */

jest.mock('../services/activityLog', () => ({ logActivity: jest.fn() }));

const userId = new mongoose.Types.ObjectId();

function makeUser(plan: any) {
  return { _id: userId, plan, isAdmin: false, toObject: () => ({ _id: userId, plan }) };
}

describe('checkProfileQuota', () => {
  afterEach(() => jest.restoreAllMocks());

  it('permite si el plan no tiene tope', async () => {
    jest.spyOn(User, 'findById').mockResolvedValue(makeUser('enterprise') as any);
    // El -1 nunca debe disparar un countDocuments.
    const spy = jest.spyOn(Profile, 'countDocuments');
    const res = await checkProfileQuota(userId, 100);
    expect(res.ok).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it('devuelve 404 si el usuario no existe', async () => {
    jest.spyOn(User, 'findById').mockResolvedValue(null as any);
    const res = await checkProfileQuota(userId, 1);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(404);
  });

  it('permite crear si hay margen', async () => {
    const plan = 'specter';
    const limit = PLAN_LIMITS[plan].maxProfiles;
    jest.spyOn(User, 'findById').mockResolvedValue(makeUser(plan) as any);
    jest.spyOn(Profile, 'countDocuments').mockResolvedValue(limit - 1 as any);

    const res = await checkProfileQuota(userId, 1);
    expect(res.ok).toBe(true);
  });

  it('bloquea si se alcanza el tope de uno en uno', async () => {
    const plan = 'specter';
    const limit = PLAN_LIMITS[plan].maxProfiles;
    jest.spyOn(User, 'findById').mockResolvedValue(makeUser(plan) as any);
    jest.spyOn(Profile, 'countDocuments').mockResolvedValue(limit as any);

    const res = await checkProfileQuota(userId, 1);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(403);
      expect(res.code).toBe('PLAN_LIMIT_REACHED');
      expect(res.limit).toBe(limit);
    }
  });

  it('usa la MISMA comparación al pedir varios que al pedir uno', async () => {
    // Esta es la invariante que el bug original rompía: /check usa count >= limit y
    // /bulk count + n > limit. Aquí ambas pasan por la misma aritmética.
    const plan = 'specter';
    const limit = PLAN_LIMITS[plan].maxProfiles;
    jest.spyOn(User, 'findById').mockResolvedValue(makeUser(plan) as any);

    // Justo en el límite: pedir 1 ya no cabe, pedir 0 sí.
    jest.spyOn(Profile, 'countDocuments').mockResolvedValue(limit as any);
    expect((await checkProfileQuota(userId, 1)).ok).toBe(false);
    expect((await checkProfileQuota(userId, 0)).ok).toBe(true);

    // Con hueco para 3: pedir 3 cabe, pedir 4 no.
    jest.spyOn(Profile, 'countDocuments').mockResolvedValue(limit - 3 as any);
    expect((await checkProfileQuota(userId, 3)).ok).toBe(true);
    expect((await checkProfileQuota(userId, 4)).ok).toBe(false);
  });

  it('el mensaje distingue creación única de importación masiva', async () => {
    const plan = 'specter';
    const limit = PLAN_LIMITS[plan].maxProfiles;
    jest.spyOn(User, 'findById').mockResolvedValue(makeUser(plan) as any);
    jest.spyOn(Profile, 'countDocuments').mockResolvedValue(limit as any);

    const uno = await checkProfileQuota(userId, 1);
    const varios = await checkProfileQuota(userId, 7);
    expect(uno.ok).toBe(false);
    expect(varios.ok).toBe(false);
    if (!uno.ok && !varios.ok) {
      expect(uno.error).not.toBe(varios.error);
      // El masivo menciona cuántos son y cuántos hay.
      expect(varios.error).toContain('7');
      expect(varios.current).toBe(limit);
    }
  });
});

describe('isValidObjectId', () => {
  it('acepta un ObjectId de 24 hex', () => {
    expect(isValidObjectId('507f1f77bcf86cd799439011')).toBe(true);
  });

  it('rechaza basura que produciría un 500 al castear', () => {
    // Sin esto, un /api/profiles/loquesea revienta con un CastError en vez de
    // un 400 con un mensaje útil.
    for (const malo of ['basura', '../../etc/passwd', "'; DROP TABLE", '', '123', 'zzzf1f77bcf86cd799439011']) {
      expect(isValidObjectId(malo)).toBe(false);
    }
  });
});