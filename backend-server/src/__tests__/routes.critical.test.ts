import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import sessionsRouter from '../routes/sessions';
import keysRouter from '../routes/keys';
import membershipRouter from '../routes/membership';
import dashboardRouter from '../routes/dashboard';
import Session from '../models/Session';
import Profile from '../models/Profile';
import LicenseKey from '../models/LicenseKey';
import User from '../models/User';
import ApiKey from '../models/ApiKey';
import { errorHandler } from '../errorMiddleware';
import { getSubscriptionStatus } from '../services/subscriptionService';

/**
 * Tests HTTP de las rutas de COBRO y de sesiones.
 *
 * De las 63 rutas del backend, estas 15 no tenían ningún test HTTP. Y son las
 * que cobran: claves, planes y sesiones. Un 200 donde toca 400 aquí no se
 * nota hasta que un cliente lo encuentra.
 *
 * Se prueban las tres cosas que se rompen:
 *   1. un identificador mal formado -> 400, no 500
 *   2. tocar un recurso de otro usuario -> 403/404, nunca 200
 *   3. límite de plan -> 403 con cuerpo rico, no 500
 *
 * Hay tres rutas (sessions/start, keys PATCH y keys DELETE) que hoy devuelven
 * 500 en vez de 400 cuando el :id no es un ObjectId. Esos tests van a fallar
 * en rojo hasta que la ruta se corrija, que es justamente lo que los hace
 * útiles: quedan de prueba del bug.
 *
 * Los mocks de los modelos imitan lo que hace Mongoose de verdad: un
 * findById('cadena que no es un ObjectId') lanza CastError de forma síncrona.
 * Así se prueba la RUTA, no el mock.
 */

jest.mock('../authMiddleware', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    // El rol se puede forzar con la cabecera x-test-role, porque solo un seller
    // tiene la restricción de no tocar claves ajenas, y sin ella no se puede
    // probar. Si no se manda, es un usuario normal.
    req.user = {
      _id: new mongoose.Types.ObjectId(),
      username: 'tester',
      role: req.headers['x-test-role'] || 'user',
      plan: 'shadow',
    };
    next();
  },
  requireSeller: (_req: any, _res: any, next: any) => next(),
  requireAdmin: (_req: any, _res: any, next: any) => next(),
  requireOwner: (_req: any, _res: any, next: any) => next(),
}));

jest.mock('mongoose', () => {
  const actual = jest.requireActual('mongoose');
  return {
    ...actual,
    connect: jest.fn().mockResolvedValue(undefined),
    connection: { readyState: 1, collections: {}, close: jest.fn() },
  };
});

jest.mock('../models/Session', () => ({ __esModule: true, default: { find: jest.fn(), findById: jest.fn(), countDocuments: jest.fn(), create: jest.fn() } }));
jest.mock('../models/Profile', () => ({ __esModule: true, default: { findById: jest.fn(), countDocuments: jest.fn(), find: jest.fn() } }));
jest.mock('../models/LicenseKey', () => ({ __esModule: true, default: { find: jest.fn(), findById: jest.fn(), insertMany: jest.fn() } }));
jest.mock('../models/User', () => {
  const PLAN_LIMITS = {
    shadow: { maxProfiles: 50, maxSessions: 10, maxApiKeys: 2 },
    specter: { maxProfiles: 200, maxSessions: 15, maxApiKeys: 5 },
  };
  return { __esModule: true, PLAN_LIMITS, default: { findById: jest.fn() } };
});
jest.mock('../models/ApiKey', () => ({ __esModule: true, default: { countDocuments: jest.fn() } }));

jest.mock('../services/subscriptionService', () => ({
  checkAndHandleSubscriptionExpiry: jest.fn(),
  getSubscriptionStatus: jest.fn(() => ({
    normalizedPlan: 'shadow', planName: 'Shadow', isLifetime: false,
    daysRemaining: 30, planExpiresAt: null,
    limits: { maxProfiles: 50, maxSessions: 10, maxApiKeys: 2 },
  })),
  redeemLicenseKey: jest.fn(),
}));

// Cadena de Mongoose simulada: .populate().sort().limit() devuelve lo mismo y
// es thenable, que es lo que espera `await`.
function chain(result: unknown) {
  const q: any = {
    populate: () => q,
    sort: () => q,
    limit: () => q,
    select: () => q,
    lean: () => q,
    then: (r: any) => r(result),
  };
  return q;
}

// Un documento de Mongoose simulado: .equals(), .save(), .deleteOne().
function doc(data: Record<string, unknown>): any {
  return {
    ...data,
    equals(other: unknown) { return String((this as any)._id) === String(other); },
    save: jest.fn().mockResolvedValue(undefined),
    deleteOne: jest.fn().mockResolvedValue(undefined),
  };
}

function makeApp(mounts: Record<string, express.Router>) {
  const app = express();
  app.use(express.json());
  for (const [path, router] of Object.entries(mounts)) {
    app.use(path, router);
  }
  app.use(errorHandler);
  return app;
}

// El CastError real de Mongoose: findById('cadena') lo lanza síncronamente.
function castError() {
  const e = new Error('Cast to ObjectId failed');
  e.name = 'CastError';
  return e;
}

beforeEach(() => {
  // resetAllMocks y no clearAllMocks: clear limpia llamadas pero conserva los
  // mockImplementation de tests anteriores, así que un test que hacía lanzar a
  // findById dejaba a los siguientes con un mock roto sin que se notara. Reset
  // sí elimina las implementaciones.
  //
  // Pero reset también borra los defaults de la factoría, así que hay que
  // volver a ponerlos. Es el precio de que los tests no se contaminen.
  jest.resetAllMocks();
  (getSubscriptionStatus as jest.Mock).mockReturnValue({
    normalizedPlan: 'shadow', planName: 'Shadow', isLifetime: false,
    daysRemaining: 30, planExpiresAt: null,
    limits: { maxProfiles: 50, maxSessions: 10, maxApiKeys: 2 },
  });
});

describe('sessions.ts', () => {
  const app = makeApp({ '/api/sessions': sessionsRouter });
  const OTRA_PERSONA = new mongoose.Types.ObjectId();

  it('POST /start con un profileId mal formado da 400, no 500', async () => {
    // Mongoose lanzaría CastError aquí. La ruta no lo comprueba, así que hoy
    // responde 500 culpando al servidor de una petición mal formada del cliente.
    (User.findById as jest.Mock).mockResolvedValue(doc({ plan: 'shadow' }));
    (Session.countDocuments as jest.Mock).mockResolvedValue(0);
    (Profile.findById as jest.Mock).mockImplementation(() => { throw castError(); });

    const res = await request(app).post('/api/sessions/start').send({ profileId: 'no-es-un-objectid' });

    expect(res.status).toBe(400);
  });

  it('POST /start sobre el perfil de otra persona da 403, nunca 200', async () => {
    (User.findById as jest.Mock).mockResolvedValue(doc({ plan: 'shadow' }));
    (Session.countDocuments as jest.Mock).mockResolvedValue(0);
    // Sin userId en el documento, profile.userId es undefined y la ruta revienta
    // con TypeError -> 500 en vez de comprobar a quién pertenece.
    (Profile.findById as jest.Mock).mockResolvedValue(doc({ _id: OTRA_PERSONA, userId: OTRA_PERSONA, name: 'p' }));

    const res = await request(app).post('/api/sessions/start').send({ profileId: String(new mongoose.Types.ObjectId()) });

    expect(res.status).toBe(403);
  });

  it('POST /start por encima del límite del plan da 403 con cuerpo rico', async () => {
    (User.findById as jest.Mock).mockResolvedValue(doc({ plan: 'shadow' }));
    (Session.countDocuments as jest.Mock).mockResolvedValue(10); // maxSessions de shadow = 10

    const res = await request(app).post('/api/sessions/start').send({ profileId: String(new mongoose.Types.ObjectId()) });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PLAN_LIMIT_REACHED');
    expect(res.body.limit).toBe(10);
    expect(res.body.current).toBe(10);
  });

  it('POST /:id/stop con un id mal formado da 400', async () => {
    const res = await request(app).post('/api/sessions/no-es-oid/stop');
    expect(res.status).toBe(400);
  });

  it('DELETE /:id con un id mal formado da 400', async () => {
    const res = await request(app).delete('/api/sessions/no-es-oid');
    expect(res.status).toBe(400);
  });
});

describe('keys.ts (las claves que se venden)', () => {
  const app = makeApp({ '/api/keys': keysRouter });

  it('PATCH /:id con un id mal formado da 400, no 500', async () => {
    // findById('basura') lanza CastError, y la ruta no lo comprueba.
    (LicenseKey.findById as jest.Mock).mockImplementation(() => { throw castError(); });

    const res = await request(app).patch('/api/keys/no-es-un-objectid').send({ status: 'active' });

    expect(res.status).toBe(400);
  });

  it('DELETE /:id con un id mal formado da 400, no 500', async () => {
    (LicenseKey.findById as jest.Mock).mockImplementation(() => { throw castError(); });

    const res = await request(app).delete('/api/keys/no-es-un-objectid');

    expect(res.status).toBe(400);
  });

  it('PATCH /:id sobre una clave de otro seller da 403, no 200', async () => {
    const claveAjena = doc({ _id: new mongoose.Types.ObjectId(), createdBy: new mongoose.Types.ObjectId(), status: 'active' });
    (LicenseKey.findById as jest.Mock).mockResolvedValue(claveAjena);

    // El rol seller se pasa por cabecera: solo un seller tiene la restricción
    // de no tocar claves ajenas. Sin él, la ruta la editaría igual.
    const res = await request(app)
      .patch('/api/keys/' + new mongoose.Types.ObjectId())
      .set('x-test-role', 'seller')
      .send({ tag: 'x' });

    expect(res.status).toBe(403);
  });

  it('POST / con count 0 da 400', async () => {
    const res = await request(app).post('/api/keys').send({ count: 0 });
    expect(res.status).toBe(400);
  });

  it('POST / con count 101 da 400', async () => {
    const res = await request(app).post('/api/keys').send({ count: 101 });
    expect(res.status).toBe(400);
  });
});

describe('membership.ts', () => {
  const app = makeApp({ '/api/membership': membershipRouter });

  it('GET /plans devuelve los planes sin pedir sesión', async () => {
    const res = await request(app).get('/api/membership/plans');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('POST /redeem sin clave da 400', async () => {
    const res = await request(app).post('/api/membership/redeem').send({});
    expect(res.status).toBe(400);
  });

  it('GET /status sin usuario devuelve 404', async () => {
    (User.findById as jest.Mock).mockResolvedValue(null);

    const res = await request(app).get('/api/membership/status');
    expect(res.status).toBe(404);
  });

  it('GET /usage devuelve los contadores del usuario', async () => {
    (User.findById as jest.Mock).mockResolvedValue(doc({ plan: 'shadow' }));
    (Profile.countDocuments as jest.Mock).mockResolvedValue(3);
    (ApiKey.countDocuments as jest.Mock).mockResolvedValue(1);
    (Session.countDocuments as jest.Mock).mockResolvedValue(2);

    const res = await request(app).get('/api/membership/usage');

    expect(res.status).toBe(200);
    expect(res.body.usage.profiles.current).toBe(3);
    expect(res.body.usage.sessions.current).toBe(2);
    expect(res.body.usage.apiKeys.current).toBe(1);
  });
});

describe('dashboard.ts', () => {
  const app = makeApp({ '/api/dashboard': dashboardRouter });

  it('GET / agrega los contadores sin consultar en serie', async () => {
    (Profile.countDocuments as jest.Mock).mockResolvedValue(5);
    (Session.countDocuments as jest.Mock).mockResolvedValue(7);
    (Profile.find as jest.Mock).mockReturnValue(chain([]));
    (Session.find as jest.Mock).mockReturnValue(chain([{ duration: 30 }, { duration: 60 }]));
    (ApiKey.countDocuments as jest.Mock).mockResolvedValue(2);

    const res = await request(app).get('/api/dashboard');

    expect(res.status).toBe(200);
    expect(res.body.profilesCount).toBe(5);
    expect(res.body.sessionsCount).toBe(7);
    expect(res.body.totalMinutes).toBe(90);
  });
});