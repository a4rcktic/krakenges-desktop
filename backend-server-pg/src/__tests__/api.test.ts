import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import speakeasy from 'speakeasy';
import type { Express } from 'express';
import type { TestContext } from './helpers';
import { createTestContext, seedLicenseKey, seedOwner, seedUser } from './helpers';

let ctx: TestContext;
let app: Express;
let userAgent: ReturnType<typeof request.agent>;
let ownerAgent: ReturnType<typeof request.agent>;

let userId = '';
let profileId = '';
let sessionId = '';
let apiKeyId = '';
let apiKeyValue = '';
let ownerKey = '';
let ownerId = '';

beforeAll(async () => {
  ctx = await createTestContext();
  app = ctx.app;
});

afterAll(async () => {
  await ctx.close();
});

describe.sequential('Kraken Ges API (PGlite)', () => {
  it('responde /health con la base de datos en ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', database: 'ok' });
  });

  it('registra un usuario con una licencia Shadow', async () => {
    const license = await seedLicenseKey(ctx.db, { plan: 'shadow', durationDays: 30 });
    userAgent = request.agent(app);

    const res = await userAgent.post('/api/auth/register').send({
      name: 'Usuario Test',
      username: 'usuario_test',
      email: 'usuario@example.com',
      password: 'Password123!',
      key: license.key,
    });

    expect(res.status).toBe(201);
    expect(res.body.accessToken).toBeTypeOf('string');
    expect(res.body.user).toMatchObject({
      username: 'usuario_test',
      plan: 'shadow',
      role: 'user',
    });
    expect(res.body.user.ticket).toBeTypeOf('string');

    userId = res.body.user.id;
    expect(userId).toBeTypeOf('string');
  });

  it('rechaza registrar de nuevo la misma licencia', async () => {
    const res = await request(app).post('/api/auth/register').send({
      name: 'Otro Usuario',
      username: 'otro_usuario',
      email: 'otro@example.com',
      password: 'Password123!',
      key: 'MSK-NO-EXISTE',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('no existe');
  });

  it('devuelve /users/me con el plan y los límites', async () => {
    const res = await userAgent.get('/api/users/me');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: userId,
      username: 'usuario_test',
      normalizedPlan: 'shadow',
    });
    expect(res.body.limits.maxProfiles).toBeGreaterThan(0);
  });

  it('crea un perfil con tags y estado de navegador', async () => {
    const res = await userAgent.post('/api/profiles').send({
      name: 'Perfil Test',
      startUrl: 'https://example.com',
      tags: ['alpha', 'beta'],
      notes: 'perfil de prueba',
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'Perfil Test' });
    expect(res.body.tags).toEqual(['alpha', 'beta']);
    profileId = res.body.id;

    const state = await userAgent.get(`/api/profiles/${profileId}/browser-state`);
    expect(state.status).toBe(200);
    expect(state.body).toMatchObject({ hasState: true, cookiesCount: 0 });
  });

  it('lista perfiles y agrega tags', async () => {
    const list = await userAgent.get('/api/profiles');
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);

    const tags = await userAgent.get('/api/profiles/tags');
    expect(tags.status).toBe(200);
    expect(tags.body).toEqual(
      expect.arrayContaining([
        { tag: 'alpha', count: 1 },
        { tag: 'beta', count: 1 },
      ]),
    );
  });

  it('fija el SO del fingerprint la primera vez y lo mantiene', async () => {
    const first = await userAgent
      .post('/api/fingerprint')
      .send({ profileId, os: 'windows' });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ os: 'windows', osSource: 'requested' });
    expect(first.body.identity.timezone).toBeTypeOf('string');

    const second = await userAgent.post('/api/fingerprint').send({ profileId });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ os: 'windows', osSource: 'stored' });
    expect(second.body.seed).toBe(first.body.seed);
    expect(second.body.identity).toEqual(first.body.identity);
  });

  it('guarda y lee el estado de navegador', async () => {
    const cookies = JSON.stringify([{ name: 'sid', value: 'abc' }]);
    const localStorage = JSON.stringify({ theme: 'dark' });

    const put = await userAgent
      .put(`/api/profiles/${profileId}/browser-state`)
      .send({ cookies, localStorage });
    expect(put.status).toBe(200);

    const get = await userAgent.get(`/api/profiles/${profileId}/browser-state`);
    expect(get.status).toBe(200);
    expect(get.body).toMatchObject({ hasState: true, cookiesCount: 1 });
  });

  it('inicia, lista y detiene una sesión', async () => {
    const start = await userAgent
      .post('/api/sessions/start')
      .send({ profileId });
    expect(start.status).toBe(201);
    expect(start.body).toMatchObject({ status: 'active' });
    // Mongo devolvía el ObjectId como string en las mutaciones.
    expect(start.body.profileId).toBe(profileId);
    sessionId = start.body.id;

    const list = await userAgent.get('/api/sessions');
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    // La lista sí viene con populate: el cliente usa proxy/startUrl al reanudar.
    expect(list.body[0].profileId).toMatchObject({
      id: profileId,
      name: 'Perfil Test',
      startUrl: 'https://example.com',
      tags: ['alpha', 'beta'],
      notes: 'perfil de prueba',
    });
    expect(list.body[0].profileId.userId).toBeTypeOf('string');
    expect(list.body[0].profileId.createdAt).toBeTypeOf('string');

    const stop = await userAgent.post(`/api/sessions/${sessionId}/stop`);
    expect(stop.status).toBe(200);
    expect(stop.body.status).toBe('stopped');
    expect(stop.body.duration).toBeTypeOf('number');
    expect(stop.body.profileId).toBe(profileId);
  });

  it('mantiene el contrato 2FA con userId y preAuthToken', async () => {
    const secret = speakeasy.generateSecret({ length: 32 });
    const { user, password } = await seedUser(ctx.db, {
      plan: 'shadow',
      twoFactorEnabled: true,
      twoFactorSecret: secret.base32,
    });

    const login = await request(app).post('/api/auth/login').send({
      username: user.username,
      password,
    });
    expect(login.status).toBe(200);
    expect(login.body).toMatchObject({
      requires2FA: true,
      userId: user.id,
    });
    expect(login.body.preAuthToken).toBeTypeOf('string');

    const token = speakeasy.totp({
      secret: secret.base32,
      encoding: 'base32',
    });

    // Contrato histórico: el cliente envía userId.
    const viaUserId = await request(app)
      .post('/api/auth/login/2fa')
      .send({ userId: user.id, token });
    expect(viaUserId.status).toBe(200);
    expect(viaUserId.body.user.id).toBe(user.id);

    // Contrato nuevo: también se acepta el token pre-auth.
    const viaPreAuth = await request(app)
      .post('/api/auth/login/2fa')
      .send({ preAuthToken: login.body.preAuthToken, token });
    expect(viaPreAuth.status).toBe(200);
    expect(viaPreAuth.body.user.id).toBe(user.id);
  });

  it('expone el dashboard y el uso del plan', async () => {
    const dashboard = await userAgent.get('/api/dashboard');
    expect(dashboard.status).toBe(200);
    expect(dashboard.body).toMatchObject({
      profilesCount: 1,
      sessionsCount: 1,
      activeSessionsCount: 0,
    });

    const usage = await userAgent.get('/api/membership/usage');
    expect(usage.status).toBe(200);
    expect(usage.body.usage.profiles.current).toBe(1);
    expect(usage.body.usage.sessions.current).toBe(0);
  });

  it('crea una API key, la usa y la desactiva', async () => {
    const created = await userAgent.post('/api/apikeys').send({ name: 'CI' });
    expect(created.status).toBe(201);
    expect(created.body.key).toMatch(/^gwt_/);
    apiKeyId = created.body.id;
    apiKeyValue = created.body.key;

    const viaKey = await request(app)
      .get('/api/users/me')
      .set('x-api-key', apiKeyValue);
    expect(viaKey.status).toBe(200);
    expect(viaKey.body.id).toBe(userId);

    const toggled = await userAgent.patch(`/api/apikeys/${apiKeyId}/toggle`);
    expect(toggled.status).toBe(200);
    expect(toggled.body.isActive).toBe(false);

    const rejected = await request(app)
      .get('/api/users/me')
      .set('x-api-key', apiKeyValue);
    expect(rejected.status).toBe(401);
  });

  it('permite al owner listar usuarios, ver analíticas y exportar', async () => {
    const { owner, password } = await seedOwner(ctx.db);
    ownerId = owner.id;
    ownerAgent = request.agent(app);

    const login = await ownerAgent
      .post('/api/auth/login')
      .send({ username: owner.username, password });
    expect(login.status).toBe(200);
    expect(login.body.user.role).toBe('owner');

    const users = await ownerAgent.get('/api/users');
    expect(users.status).toBe(200);
    expect(users.body.length).toBeGreaterThanOrEqual(2);

    const analytics = await ownerAgent.get('/api/users/admin/analytics');
    expect(analytics.status).toBe(200);
    expect(analytics.body.totalUsers).toBeGreaterThanOrEqual(2);

    const backup = await ownerAgent.get('/api/users/admin/backup');
    expect(backup.status).toBe(200);
    expect(backup.body.usersCount).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(backup.body.users)).toBe(true);
  });

  it('genera claves como owner, incluidas claves de 5 horas', async () => {
    const res = await ownerAgent.post('/api/keys').send({
      plan: 'specter',
      durationDays: 0.2083,
      count: 2,
      tag: 'test-5h',
    });

    expect(res.status).toBe(201);
    expect(res.body.count).toBe(2);
    expect(res.body.keys).toHaveLength(2);
    expect(res.body.keys[0].key).toMatch(/^MSK-SPEC-/);
    expect(res.body.keys[0].durationDays).toBeCloseTo(0.2083, 4);
    ownerKey = res.body.keys[0].key;

    const list = await ownerAgent.get('/api/keys?tag=test-5h');
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(2);
    expect(list.body[0].createdBy).toMatchObject({ username: 'owner' });
  });

  it('descuenta créditos de seller de forma atómica y rechaza sin saldo', async () => {
    const { user: seller, password } = await seedUser(ctx.db, {
      role: 'seller',
      plan: 'shadow',
      sellerCredits: 1,
    });
    const sellerAgent = request.agent(app);

    const login = await sellerAgent
      .post('/api/auth/login')
      .send({ username: seller.username, password });
    expect(login.status).toBe(200);

    const first = await sellerAgent
      .post('/api/keys')
      .send({ plan: 'shadow', count: 1 });
    expect(first.status).toBe(201);
    expect(first.body.remainingSellerCredits).toBe(0);

    const second = await sellerAgent
      .post('/api/keys')
      .send({ plan: 'shadow', count: 1 });
    expect(second.status).toBe(403);
    expect(second.body.currentCredits).toBe(0);
    expect(second.body.requestedCount).toBe(1);

    const adminKey = await sellerAgent
      .post('/api/keys')
      .send({ plan: 'shadow', role: 'admin', count: 1 });
    expect(adminKey.status).toBe(403);
  });

  it('rechaza que un seller defina límites personalizados', async () => {
    const { user: seller, password } = await seedUser(ctx.db, {
      role: 'seller',
      plan: 'shadow',
      sellerCredits: 5,
    });
    const sellerAgent = request.agent(app);

    const login = await sellerAgent
      .post('/api/auth/login')
      .send({ username: seller.username, password });
    expect(login.status).toBe(200);

    const res = await sellerAgent.post('/api/keys').send({
      plan: 'shadow',
      customPlanName: 'Ilimitado',
      maxProfiles: -1,
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('límites');
  });

  it('impide que un admin cambie el plan del Owner', async () => {
    const { user: admin, password } = await seedUser(ctx.db, {
      role: 'admin',
      isAdmin: true,
      plan: 'phantom',
    });
    const adminAgent = request.agent(app);

    const login = await adminAgent
      .post('/api/auth/login')
      .send({ username: admin.username, password });
    expect(login.status).toBe(200);

    const res = await adminAgent
      .patch(`/api/users/${ownerId}/plan`)
      .send({ plan: 'ghost' });
    expect(res.status).toBe(403);
  });

  it('registra con una clave de 5 horas y calcula la expiración en horas', async () => {
    const agent = request.agent(app);
    const before = Date.now();

    const res = await agent.post('/api/auth/register').send({
      name: 'Usuario Cinco Horas',
      username: 'cinco_horas',
      email: 'cinco@example.com',
      password: 'Password123!',
      key: ownerKey,
    });

    expect(res.status).toBe(201);
    expect(res.body.user.plan).toBe('specter');

    const expiresAt = new Date(res.body.user.planExpiresAt).getTime();
    const hours = (expiresAt - before) / 3_600_000;
    expect(hours).toBeGreaterThan(4.9);
    expect(hours).toBeLessThan(5.1);
  });

  it('canjea una licencia y extiende el plan', async () => {
    const license = await seedLicenseKey(ctx.db, { plan: 'shadow', durationDays: 1 });
    const before = await userAgent.get('/api/users/me');
    const beforeExpiry = new Date(before.body.planExpiresAt).getTime();

    const res = await userAgent
      .post('/api/membership/redeem')
      .send({ key: license.key });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const after = await userAgent.get('/api/users/me');
    const afterExpiry = new Date(after.body.planExpiresAt).getTime();
    expect(afterExpiry).toBeGreaterThan(beforeExpiry);
  });

  it('borra el perfil y conserva la sesión con profileId nulo', async () => {
    const del = await userAgent.delete(`/api/profiles/${profileId}`);
    expect(del.status).toBe(200);

    const sessions = await userAgent.get('/api/sessions');
    expect(sessions.status).toBe(200);
    expect(sessions.body[0].profileId).toBeNull();

    const state = await userAgent.get(`/api/profiles/${profileId}/browser-state`);
    expect(state.status).toBe(404);
  });
});
