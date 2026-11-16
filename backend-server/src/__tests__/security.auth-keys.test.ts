import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import speakeasy from 'speakeasy';
import { errorHandler } from '../errorMiddleware';
import { sanitizeInput } from '../sanitizeMiddleware';
import User from '../models/User';
import LicenseKey from '../models/LicenseKey';
import authRouter from '../routes/auth';
import usersRouter from '../routes/users';
import keysRouter from '../routes/keys';
import { hayBaseDeDatos, connectTestDb, cleanTestDb, disconnectTestDb } from './mongoMemory';

/**
 * Regresiones de seguridad de la auditoría del 31/10:
 *   1. /login/2fa aceptaba userId + TOTP sin haber verificado la contraseña.
 *   2. Un seller podía devolver a 'active' una clave canjeada y revenderla.
 *   3. El descuento de créditos del seller no era atómico.
 */

const describeDb = hayBaseDeDatos() ? describe : describe.skip;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(sanitizeInput);
  app.use(cookieParser());
  app.use('/api/auth', authRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/keys', keysRouter);
  app.use(errorHandler);
  return app;
}

async function seedUser(username: string, extra: Record<string, unknown> = {}) {
  return User.create({
    name: username,
    username,
    passwordHash: await bcrypt.hash('Password123!', 4),
    ...extra,
  });
}

async function loginToken(app: express.Express, username: string): Promise<string> {
  const res = await request(app).post('/api/auth/login').send({ username, password: 'Password123!' });
  expect(res.status).toBe(200);
  return res.body.accessToken;
}

describeDb('seguridad: 2FA, claves y créditos', () => {
  let app: express.Express;

  beforeAll(async () => {
    await connectTestDb();
    app = buildApp();
  });
  afterEach(cleanTestDb);
  afterAll(disconnectTestDb);

  describe('2FA', () => {
    const secret = speakeasy.generateSecret({ length: 20 }).base32;
    const code = () => speakeasy.totp({ secret, encoding: 'base32' });

    beforeEach(async () => {
      await seedUser('dosfa', { twoFactorEnabled: true, twoFactorSecret: secret });
    });

    it('el login con contraseña no devuelve el userId sino un token pre-2FA', async () => {
      const res = await request(app).post('/api/auth/login').send({ username: 'dosfa', password: 'Password123!' });
      expect(res.status).toBe(200);
      expect(res.body.requires2FA).toBe(true);
      expect(res.body.preAuthToken).toBeTruthy();
      expect(res.body.userId).toBeUndefined();
      expect(res.body.accessToken).toBeUndefined();
    });

    it('userId + TOTP sin token pre-2FA ya no inicia sesión', async () => {
      const user = await User.findOne({ username: 'dosfa' });
      const res = await request(app)
        .post('/api/auth/login/2fa')
        .send({ userId: user!._id.toString(), token: code() });
      expect(res.status).toBe(400);
      expect(res.body.accessToken).toBeUndefined();
    });

    it('token pre-2FA + TOTP correcto inicia sesión', async () => {
      const step1 = await request(app).post('/api/auth/login').send({ username: 'dosfa', password: 'Password123!' });
      const res = await request(app)
        .post('/api/auth/login/2fa')
        .send({ preAuthToken: step1.body.preAuthToken, token: code() });
      expect(res.status).toBe(200);
      expect(res.body.accessToken).toBeTruthy();
    });

    it('el token pre-2FA no sirve como access token', async () => {
      const step1 = await request(app).post('/api/auth/login').send({ username: 'dosfa', password: 'Password123!' });
      const res = await request(app)
        .get('/api/users/me')
        .set('Authorization', `Bearer ${step1.body.preAuthToken}`);
      expect(res.status).toBe(401);
    });

    it('un access token no sirve como token pre-2FA', async () => {
      await seedUser('sin2fa');
      const access = await loginToken(app, 'sin2fa');
      const res = await request(app).post('/api/auth/login/2fa').send({ preAuthToken: access, token: code() });
      expect(res.status).toBe(401);
    });
  });

  describe('claves del seller', () => {
    let sellerToken: string;

    beforeEach(async () => {
      await seedUser('vendedor', { role: 'seller', sellerCredits: 1 });
      sellerToken = await loginToken(app, 'vendedor');
    });

    it('una clave canjeada no se puede reactivar', async () => {
      const mint = await request(app)
        .post('/api/keys')
        .set('Authorization', `Bearer ${sellerToken}`)
        .send({ plan: 'shadow', count: 1 });
      expect(mint.status).toBe(201);
      const { id, key } = mint.body.keys[0];

      const reg = await request(app).post('/api/auth/register').send({
        name: 'Cliente', username: 'cliente1', password: 'Password123!', key,
      });
      expect(reg.status).toBe(201);

      for (const body of [{ status: 'active' }, { isActive: true }]) {
        const patch = await request(app)
          .patch(`/api/keys/${id}`)
          .set('Authorization', `Bearer ${sellerToken}`)
          .send(body);
        expect(patch.status).toBe(409);
      }
      expect((await LicenseKey.findById(id))!.status).toBe('redeemed');

      const reuse = await request(app).post('/api/auth/register').send({
        name: 'Cliente', username: 'cliente2', password: 'Password123!', key,
      });
      expect(reuse.status).toBe(400);
    });

    it('una clave sin canjear se puede revocar y reactivar', async () => {
      const mint = await request(app)
        .post('/api/keys')
        .set('Authorization', `Bearer ${sellerToken}`)
        .send({ plan: 'shadow', count: 1 });
      const { id } = mint.body.keys[0];
      for (const status of ['revoked', 'active']) {
        const patch = await request(app)
          .patch(`/api/keys/${id}`)
          .set('Authorization', `Bearer ${sellerToken}`)
          .send({ status });
        expect(patch.status).toBe(200);
        expect(patch.body.status).toBe(status);
      }
    });

    it('peticiones simultáneas no gastan dos veces el mismo crédito', async () => {
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          request(app)
            .post('/api/keys')
            .set('Authorization', `Bearer ${sellerToken}`)
            .send({ plan: 'shadow', count: 1 }),
        ),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 403)).toHaveLength(4);
      expect(await LicenseKey.countDocuments()).toBe(1);
      expect((await User.findOne({ username: 'vendedor' }))!.sellerCredits).toBe(0);
    });
  });
});
