import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { TestContext } from './helpers';
import {
  createTestContext,
  seedLicenseKey,
  seedOwner,
  seedUser,
} from './helpers';

let ctx: TestContext;
let app: Express;

beforeAll(async () => {
  ctx = await createTestContext();
  app = ctx.app;
});

afterAll(async () => {
  await ctx.close();
});

async function registerWithKey(
  username: string,
  key: string,
): Promise<ReturnType<typeof request.agent>> {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/register').send({
    name: username,
    username,
    email: `${username}@example.com`,
    password: 'Password123!',
    key,
  });
  expect(res.status).toBe(201);
  return agent;
}

describe.sequential('Custom license entitlements', () => {
  it('crea una clave con duración en horas y límites personalizados', async () => {
    const { owner, password } = await seedOwner(ctx.db);
    const ownerAgent = request.agent(app);
    const login = await ownerAgent
      .post('/api/auth/login')
      .send({ username: owner.username, password });
    expect(login.status).toBe(200);

    const created = await ownerAgent.post('/api/keys').send({
      plan: 'shadow',
      durationHours: 1,
      customPlanName: 'Custom 1h',
      maxProfiles: 1,
      maxSessions: 1,
      maxApiKeys: 1,
      tag: 'custom-1h',
    });

    expect(created.status).toBe(201);
    expect(created.body.keys[0]).toMatchObject({
      customPlanName: 'Custom 1h',
      maxProfiles: 1,
      maxSessions: 1,
      maxApiKeys: 1,
    });
    expect(created.body.keys[0].durationDays).toBeCloseTo(1 / 24, 6);

    const agent = await registerWithKey('custom_user', created.body.keys[0].key);
    const me = await agent.get('/api/users/me');
    expect(me.status).toBe(200);
    expect(me.body.planName).toBe('Custom 1h');
    expect(me.body.limits).toEqual({
      maxProfiles: 1,
      maxSessions: 1,
      maxApiKeys: 1,
    });

    const expiresAt = new Date(me.body.planExpiresAt).getTime();
    const hours = (expiresAt - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(0.9);
    expect(hours).toBeLessThan(1.1);

    // La cuota se aplica también a clonar, no solo a crear.
    const profile = await agent.post('/api/profiles').send({ name: 'Uno' });
    expect(profile.status).toBe(201);
    const clone = await agent.post(`/api/profiles/${profile.body.id}/clone`);
    expect(clone.status).toBe(403);
    expect(clone.body.code).toBe('PLAN_LIMIT_REACHED');

    const second = await agent.post('/api/profiles').send({ name: 'Dos' });
    expect(second.status).toBe(403);
    expect(second.body.code).toBe('PLAN_LIMIT_REACHED');
  });

  it('aplica maxSessions al reactivar una sesión parada', async () => {
    const license = await seedLicenseKey(ctx.db, {
      plan: 'shadow',
      durationDays: 1,
      customPlanName: 'Sesiones 1',
      maxProfiles: 3,
      maxSessions: 1,
      maxApiKeys: 0,
    });
    const agent = await registerWithKey('session_user', license.key);

    const first = await agent.post('/api/profiles').send({ name: 'A' });
    const second = await agent.post('/api/profiles').send({ name: 'B' });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const sessionA = await agent
      .post('/api/sessions/start')
      .send({ profileId: first.body.id });
    expect(sessionA.status).toBe(201);

    const stopA = await agent.post(`/api/sessions/${sessionA.body.id}/stop`);
    expect(stopA.status).toBe(200);

    const sessionB = await agent
      .post('/api/sessions/start')
      .send({ profileId: second.body.id });
    expect(sessionB.status).toBe(201);

    const reactivateA = await agent.post(
      `/api/sessions/${sessionA.body.id}/reactivate`,
    );
    expect(reactivateA.status).toBe(403);
    expect(reactivateA.body.code).toBe('PLAN_LIMIT_REACHED');
  });

  it('aplica maxApiKeys al reactivar una API key inactiva', async () => {
    const license = await seedLicenseKey(ctx.db, {
      plan: 'shadow',
      durationDays: 1,
      customPlanName: 'API 1',
      maxProfiles: 3,
      maxSessions: 3,
      maxApiKeys: 1,
    });
    const agent = await registerWithKey('apikey_user', license.key);

    const first = await agent.post('/api/apikeys').send({ name: 'Primera' });
    expect(first.status).toBe(201);

    const off = await agent.patch(`/api/apikeys/${first.body.id}/toggle`);
    expect(off.status).toBe(200);
    expect(off.body.isActive).toBe(false);

    const second = await agent.post('/api/apikeys').send({ name: 'Segunda' });
    expect(second.status).toBe(201);

    const on = await agent.patch(`/api/apikeys/${first.body.id}/toggle`);
    expect(on.status).toBe(403);
    expect(on.body.code).toBe('PLAN_LIMIT_REACHED');
  });

  it('retira los límites personalizados cuando el plan caduca', async () => {
    const { user, password } = await seedUser(ctx.db, {
      plan: 'shadow',
      planExpiresAt: new Date(Date.now() - 60_000),
      customPlanName: 'Expirada',
      maxProfiles: 999,
      maxSessions: 999,
      maxApiKeys: 999,
    });

    const agent = request.agent(app);
    const login = await agent
      .post('/api/auth/login')
      .send({ username: user.username, password });
    expect(login.status).toBe(200);

    const me = await agent.get('/api/users/me');
    expect(me.status).toBe(200);
    expect(me.body.normalizedPlan).toBe('ghost');
    expect(me.body.planName).toBe('Ghost');
    expect(me.body.limits).toEqual({
      maxProfiles: 3,
      maxSessions: 2,
      maxApiKeys: 0,
    });
  });

  it('también caduca una clave personalizada que usa ghost como plan base', async () => {
    const { user, password } = await seedUser(ctx.db, {
      plan: 'ghost',
      planExpiresAt: new Date(Date.now() - 60_000),
      customPlanName: 'Ghost temporal',
      maxProfiles: 999,
      maxSessions: 999,
      maxApiKeys: 999,
    });

    const agent = request.agent(app);
    const login = await agent
      .post('/api/auth/login')
      .send({ username: user.username, password });
    expect(login.status).toBe(200);

    const me = await agent.get('/api/users/me');
    expect(me.status).toBe(200);
    expect(me.body.planName).toBe('Ghost');
    expect(me.body.limits).toEqual({
      maxProfiles: 3,
      maxSessions: 2,
      maxApiKeys: 0,
    });
  });
});
