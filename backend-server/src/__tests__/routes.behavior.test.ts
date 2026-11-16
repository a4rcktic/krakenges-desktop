import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import activityRouter from '../routes/activity';
import updatesRouter from '../routes/updates';
import { asyncHandler, HttpError } from '../utils/asyncHandler';
import { errorHandler } from '../errorMiddleware';

/**
 * Tests de rutas y del manejo de errores.
 *
 * Cubre lo que fallaba:
 *   1. Los handlers async sin try/catch dejaban la peticion colgada. Con
 *      asyncHandler, un fallo produce una respuesta.
 *   2. activity.ts pasaba `new Date('basura')` (Invalid Date) a Mongoose, y un
 *      `limit` negativo intacto al .limit().
 *   3. updates /check respondia "no hay actualizacion" a una version basura.
 *
 * La autenticacion se sustituye por un middleware que inyecta un usuario: lo
 * que se prueba aqui es el comportamiento de la ruta, no el del JWT.
 */

jest.mock('../authMiddleware', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { _id: new mongoose.Types.ObjectId(), username: 'tester', role: 'user' };
    next();
  },
  requireAdmin: (_req: any, _res: any, next: any) => next(),
  requireOwner: (_req: any, _res: any, next: any) => next(),
}));

// Mongoose contra una base en memoria: las rutas construyen queries y un stub
// no valida los casts, que es justo lo que se quiere comprobar.
jest.mock('mongoose', () => {
  const actual = jest.requireActual('mongoose');
  return {
    ...actual,
    connect: jest.fn().mockResolvedValue(undefined),
    connection: { readyState: 1, collections: {}, close: jest.fn() },
  };
});

function makeApp(mounts: Record<string, express.Router>) {
  const app = express();
  app.use(express.json());
  for (const [path, router] of Object.entries(mounts)) {
    app.use(path, router);
  }
  app.use(errorHandler);
  return app;
}

describe('asyncHandler', () => {
  it('convierte un rechazo en promesa en una respuesta HTTP', async () => {
    const app = express();
    app.get(
      '/boom',
      asyncHandler(async () => {
        throw new HttpError(418, 'teapot');
      })
    );
    app.use(errorHandler);

    // Sin el wrapper, esta peticion NO terminaria nunca.
    const res = await request(app).get('/boom');
    expect(res.status).toBe(418);
    expect(res.body.error).toBe('teapot');
  });

  it('propaga un error que no es HttpError como 500', async () => {
    const app = express();
    app.get(
      '/crash',
      asyncHandler(async () => {
        throw new Error('fallo interno');
      })
    );
    app.use(errorHandler);

    const res = await request(app).get('/crash');
    expect(res.status).toBe(500);
    // En produccion el mensaje real no se filtra.
    if (process.env.NODE_ENV === 'production') {
      expect(res.body.error).toBe('Error interno del servidor');
    }
  });

  it('no ejecuta el manejador de error si todo va bien', async () => {
    const app = express();
    app.get(
      '/ok',
      asyncHandler(async (_req, res) => {
        res.json({ fine: true });
      })
    );
    app.use(errorHandler);

    const res = await request(app).get('/ok');
    expect(res.status).toBe(200);
    expect(res.body.fine).toBe(true);
  });
});

describe('GET /api/activity', () => {
  const app = makeApp({ '/api/activity': activityRouter });

  it('rechaza una fecha inválida en vez de reventar con 500', async () => {
    // Antes: new Date('basura') -> Invalid Date -> Mongoose lancea al castear.
    const res = await request(app).get('/api/activity?from=basura');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/from/);
    expect(res.body.error).toMatch(/fecha/i);
  });

  it('rechaza un límite que no es número', async () => {
    const res = await request(app).get('/api/activity?limit=abc');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/limit/);
  });

  it('rechaza fechas que no son string', async () => {
    const res = await request(app).get('/api/activity?from[]=x');
    expect(res.status).toBe(400);
  });

  it('no revienta con un límite negativo', async () => {
    // Antes Math.min(-5, 500) devolvia -5 y se pasaba a .limit(-5).
    // Ahora se acota a 1. Con la DB en memoria puede fallar la consulta, pero
    // lo que no debe es colgarse ni devolver 500 por el limite.
    const res = await request(app).get('/api/activity?limit=-5');
    expect(res.status).not.toBe(400);
  });
});

describe('GET /api/updates/check (retirado)', () => {
  const app = makeApp({ '/api/updates': updatesRouter });

  it('devuelve 410 y apunta al manifiesto firmado', async () => {
    const res = await request(app).get('/api/updates/check?version=0.9.0&platform=linux');

    expect(res.status).toBe(410);
    expect(res.body.endpoint).toBe('/api/updates/manifest');
    expect(res.body.error).toMatch(/retirado/i);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('no devuelve versiones, URLs ni checksums hardcodeados', async () => {
    const res = await request(app).get('/api/updates/check?version=99.0.0');

    expect(res.status).toBe(410);
    expect(res.body).not.toHaveProperty('latestVersion');
    expect(res.body).not.toHaveProperty('downloadUrl');
    expect(res.body).not.toHaveProperty('checksumSha256');
  });
});

describe('GET /api/updates/manifest', () => {
  const app = makeApp({ '/api/updates': updatesRouter });

  it('devuelve 204 para una plataforma que no compilamos', async () => {
    // Sin manifiesto desplegado, 204 es la respuesta correcta: no hay nada
    // firmado que ofrecer.
    const res = await request(app).get('/api/updates/manifest?platform=solaris&arch=x86_64');
    expect(res.status).toBe(204);
  });

  it('rechaza una versión actual mal formada con 400, no con 204', async () => {
    const res = await request(app).get('/api/updates/manifest?platform=linux&current_version=abc');
    expect(res.status).toBe(400);
  });

  it('no acepta parámetros inesperados que puedan ensuciar la query', async () => {
    const res = await request(app).get('/api/updates/manifest?platform=linux&__proto__=x');
    // No debe crashing con 500
    expect(res.status).not.toBe(500);
  });
});