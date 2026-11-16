import mongoose from 'mongoose';
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { config } from '../config';
import { connectDatabase } from '../db';
import { errorHandler } from '../errorMiddleware';
import { sanitizeInput } from '../sanitizeMiddleware';
import User from '../models/User';
import LicenseKey from '../models/LicenseKey';
import Profile from '../models/Profile';
import { verifyTicket, publicKeyBase64 } from '../services/licenseTicket';
import authRouter from '../routes/auth';
import usersRouter from '../routes/users';
import keysRouter from '../routes/keys';
import membershipRouter from '../routes/membership';
import profilesRouter from '../routes/profiles';
import dashboardRouter from '../routes/dashboard';
import activityRouter from '../routes/activity';
import sessionsRouter from '../routes/sessions';
import apikeysRouter from '../routes/apikeys';

jest.setTimeout(180000);
mongoose.set('bufferCommands', false);

let mongo: MongoMemoryServer | null = null;
let mongoStarted = false;

// MongoMemoryServer requiere AVX (Mongo 5.1+) o OpenSSL 1.1 (Mongo 4.4/5.0).
// En máquinas sin AVX y sin compat de OpenSSL el test se salta automáticamente.
// En el VPS OVH (Ubuntu 22.04+ con Docker/Mongo 7+) arranca sin problemas.
beforeAll(async () => {
  try {
    mongo = await MongoMemoryServer.create();
    config.mongodbUri = mongo.getUri();
    await connectDatabase();
    mongoStarted = true;
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.warn(
      '\n[e2e-licenses] ⚠ MongoMemoryServer no pudo arrancar (' +
        (msg.includes('SIGILL') ? 'CPU sin AVX' :
         msg.includes('libcrypto') ? 'OpenSSL 1.1 no disponible' :
         msg.slice(0, 100)) +
        '). El test e2e se SALTA.\n' +
        '  → En el VPS (Docker Mongo 7+ o Ubuntu 22.04 con openssl-1.1-compat) esto arranca normal.\n',
    );
  }
});

afterAll(async () => {
  if (mongoStarted) {
    await mongoose.disconnect();
    if (mongo) await mongo.stop();
  }
});

function skipIfNoMongo() {
  if (!mongoStarted) {
    console.warn('[e2e-licenses] Saltado: MongoDB no disponible en esta máquina.');
    return true;
  }
  return false;
}

function buildApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: '5mb' }));
  app.use(sanitizeInput);
  app.use(cookieParser());

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.use('/api/auth', authRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/profiles', profilesRouter);
  app.use('/api/keys', keysRouter);
  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/activity', activityRouter);
  app.use('/api/apikeys', apikeysRouter);
  app.use('/api/membership', membershipRouter);
  app.use('/api/sessions', sessionsRouter);
  app.use(errorHandler);
  return app;
}

describe('e2e: flujo completo de licencias (VPS = autoridad)', () => {
  let app: express.Express;

  // Seeds
  let ownerToken: string;
  let sellerId: string;
  let sellerToken: string;
  const rawKeys: any[] = [];

  beforeAll(async () => {
    if (skipIfNoMongo()) return;

    app = buildApp();

    // Seed del Owner (bootstrap: solo existe en producción por seeding manual).
    const owner = await User.create({
      name: 'Owner Root',
      username: 'ownerroot',
      email: 'owner@krakenges.test',
      passwordHash: await bcrypt.hash('OwnerPass123!', 10),
      role: 'owner',
      isAdmin: true,
      plan: 'enterprise',
      isLifetime: true,
    });
    expect(owner.role).toBe('owner');
  });

  it('health check responde', async () => {
    if (skipIfNoMongo()) return;
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('la clave pública incrustada en el binario es la misma del servidor (guard de rotación)', () => {
    if (skipIfNoMongo()) return;
    expect(publicKeyBase64()).toBe(
      'MCowBQYDK2VwAyEAu8yOSrQzEUcY+l6mSDPZGWdb8Ysgj1fbEmnjhHpqiBE=',
    );
  });

  it('registro sin clave -> plan ghost + ticket firmado válido (sub = userId)', async () => {
    if (skipIfNoMongo()) return;
    const res = await request(app).post('/api/auth/register').send({
      name: 'Customer Uno',
      username: 'customeruno',
      email: 'cuno@krakenges.test',
      password: 'Password123!',
    });
    expect(res.status).toBe(201);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.user.id).toBeTruthy();
    expect(res.body.user.plan).toBe('ghost');

    const verified = verifyTicket(res.body.user.ticket);
    expect(verified).not.toBeNull();
    expect(verified!.sub).toBe(res.body.user.id.toString());
  });

  it('login owner y asignación de rol seller con créditos', async () => {
    if (skipIfNoMongo()) return;
    const { accessToken } = await login(app, 'ownerroot', 'OwnerPass123!');
    ownerToken = accessToken;

    // Registramos al seller y el owner lo promociona con créditos.
    const reg = await request(app).post('/api/auth/register').send({
      name: 'Seller Uno',
      username: 'selleruno',
      email: 'seller@krakenges.test',
      password: 'Password123!',
    });
    expect(reg.status).toBe(201);
    sellerId = reg.body.user.id;

    const prom = await request(app)
      .patch(`/api/users/${sellerId}/role`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ role: 'seller', sellerCredits: 5 });
    expect(prom.status).toBe(200);
    expect(prom.body.role).toBe('seller');
    expect(prom.body.sellerCredits).toBe(5);
  });

  it('seller acuña claves (descuento de créditos) y solo ve las suyas', async () => {
    if (skipIfNoMongo()) return;
    const { accessToken } = await login(app, 'selleruno', 'Password123!');
    sellerToken = accessToken;

    const mint = await request(app)
      .post('/api/keys')
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ plan: 'shadow', durationDays: 30, count: 2, tag: 'venta' });
    expect(mint.status).toBe(201);
    expect(mint.body.count).toBe(2);
    expect(mint.body.remainingSellerCredits).toBe(3);
    rawKeys.push(...mint.body.keys);

    const mint2 = await request(app)
      .post('/api/keys')
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ plan: 'specter', durationDays: 30, count: 1, tag: 'venta' });
    expect(mint2.status).toBe(201);
    rawKeys.push(...mint2.body.keys);
    expect(rawKeys).toHaveLength(3);

    const list = await request(app)
      .get('/api/keys')
      .set('Authorization', `Bearer ${sellerToken}`);
    expect(list.status).toBe(200);
    expect(list.body.every((k: any) => k.createdBy?._id === sellerId || k.createdBy?.id === sellerId)).toBe(true);
    expect(list.body.length).toBe(3);
  });

  it('registro CON clave -> plan sombra + ticket refleja el plan', async () => {
    if (skipIfNoMongo()) return;
    const res = await request(app).post('/api/auth/register').send({
      name: 'Customer Dos',
      username: 'customerdos',
      email: 'cdos@krakenges.test',
      password: 'Password123!',
      key: rawKeys[0].key,
    });
    expect(res.status).toBe(201);
    expect(res.body.user.plan).toBe('shadow');
    const verified = verifyTicket(res.body.user.ticket);
    expect(verified).not.toBeNull();
    expect(verified!.sub).toBe(res.body.user.id.toString());
  });

  it('canje de segunda clave (specter) -> upgrade y ticket fresco', async () => {
    if (skipIfNoMongo()) return;
    const { accessToken, user } = await login(app, 'customerdos', 'Password123!');

    const redeem = await request(app)
      .post('/api/membership/redeem')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ key: rawKeys[2].key });
    expect(redeem.status).toBe(200);
    expect(redeem.body.success).toBe(true);

    const ticket = await request(app)
      .get('/api/auth/ticket')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(ticket.status).toBe(200);
    expect(ticket.body.user.plan).toBe('specter');
    const verified = verifyTicket(ticket.body.user.ticket);
    expect(verified).not.toBeNull();
    expect(verified!.sub).toBe(user.id.toString());
  });

  it('ticket forjado/tamperado se rechaza', async () => {
    if (skipIfNoMongo()) return;
    const { accessToken } = await login(app, 'selleruno', 'Password123!');
    const ticket = await request(app)
      .get('/api/auth/ticket')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(ticket.status).toBe(200);
    const good = ticket.body.user.ticket as string;
    const dot = good.indexOf('.');
    const tampered = 'A' + good.slice(1);
    expect(verifyTicket(tampered)).toBeNull();
    expect(verifyTicket(good)).not.toBeNull();
    expect(verifyTicket(good.slice(0, dot + 1) + good.slice(dot + 1, good.length - 1) + 'x')).toBeNull();
  });

  it('refresh del token renueva el access token', async () => {
    if (skipIfNoMongo()) return;
    const { refreshToken, user } = await login(app, 'customerdos', 'Password123!');
    const ref = await request(app).post('/api/auth/refresh').send({ refreshToken });
    expect(ref.status).toBe(200);
    expect(ref.body.accessToken).toBeTruthy();
    expect(ref.body.refreshToken).toBeTruthy();

    const ticket = await request(app)
      .get('/api/auth/ticket')
      .set('Authorization', `Bearer ${ref.body.accessToken}`);
    expect(ticket.status).toBe(200);
    expect(ticket.body.user.id).toBe(user.id.toString());
  });

  it('advertencia: el OWNER global ve usuarios con stats y analíticas', async () => {
    if (skipIfNoMongo()) return;
    const list = await request(app)
      .get('/api/users')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(list.status).toBe(200);
    const seller = list.body.find((u: any) => u.id === sellerId);
    expect(seller).toBeTruthy();
    expect(seller.role).toBe('seller');
    expect(seller.sellerCredits).toBe(3);
    expect(seller.stats.profiles.current).toBe(0);

    const analytics = await request(app)
      .get('/api/users/admin/analytics')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(analytics.status).toBe(200);
    expect(analytics.body.totalUsers).toBeGreaterThanOrEqual(4);
  });

  it('ban + cancelación del ticket en el middleware de auth', async () => {
    if (skipIfNoMongo()) return;
    const { accessToken, user } = await login(app, 'customerdos', 'Password123!');
    const ban = await request(app)
      .patch(`/api/users/${user.id}/ban`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ banned: true });
    expect(ban.status).toBe(200);
    expect(ban.body.banned).toBe(true);

    const ticket = await request(app)
      .get('/api/auth/ticket')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(ticket.status).toBe(403);
  });

  it('eliminar usuario (cascada) limpia perfiles y claves generadas', async () => {
    if (skipIfNoMongo()) return;
    // El seller crea un perfil propio para probar el borrado en cascada.
    const prof = await request(app)
      .post('/api/profiles')
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ name: 'Perfil Del Seller' });
    expect(prof.status).toBe(201);

    const del = await request(app)
      .delete(`/api/users/${sellerId}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(del.status).toBe(200);

    expect(await User.findById(sellerId)).toBeNull();
    expect(await Profile.countDocuments({ userId: sellerId })).toBe(0);
    expect(await LicenseKey.countDocuments({ createdBy: sellerId })).toBe(0);

    const list = await request(app)
      .get('/api/users')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(list.body.find((u: any) => u.id === sellerId)).toBeUndefined();
  });
});

async function login(app: express.Express, username: string, password: string) {
  const res = await request(app).post('/api/auth/login').send({ username, password });
  expect(res.status).toBe(200);
  return res.body as { accessToken: string; refreshToken: string; user: any };
}
