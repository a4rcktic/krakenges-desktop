import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import Profile from '../models/Profile';
import fingerprintRouter from '../routes/fingerprint';
import { autoOs } from '../services/fingerprintService';
import { errorHandler } from '../errorMiddleware';

/**
 * Comportamiento de POST /api/fingerprint con el campo `os`.
 *
 * Lo que se prueba aquí es lo que NO se puede probar en fingerprintService.test.ts:
 * que el SO pedido por el cliente se FIJA en el perfil y que a partir de ahí manda
 * lo guardado. Sin esa fijación, dos peticiones del mismo perfil podrían devolver
 * sistemas distintos y la huella dejaría de ser estable, que es lo único que la
 * hace inservible para un antidetect.
 *
 * Profile se sustituye por un doble: la ruta solo hace findOne y save, y montar
 * una base en memoria para probar dos líneas no compensa. `resolveOs` sí se
 * prueba de verdad, en fingerprintService.test.ts.
 */

jest.mock('../authMiddleware', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { _id: new mongoose.Types.ObjectId(), username: 'tester', role: 'user' };
    next();
  },
  requireAdmin: (_req: any, _res: any, next: any) => next(),
  requireOwner: (_req: any, _res: any, next: any) => next(),
}));

/** Perfil simulado, con lo mínimo que la ruta toca. */
function fakeProfile(id: string, os?: string) {
  return {
    id,
    _id: new mongoose.Types.ObjectId(id),
    os,
    saved: 0,
    async save() {
      this.saved += 1;
      return this;
    },
  };
}

// El doble. `mock` como prefijo porque jest.mock se hoistea por encima de las
// declaraciones: sin ese prefijo, la factoría vería `undefined`.
var mockProfile: any;

jest.mock('../models/Profile', () => ({
  __esModule: true,
  default: {
    // thenable, que es lo que espera `await` sobre una query de Mongoose.
    findOne: jest.fn(() => ({ then: (r: any) => r(mockProfile) })),
  },
}));

let current: any = fakeProfile('6aa8d4e65a7a287c0aac87a6');
mockProfile = current;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/fingerprint', fingerprintRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  (Profile.findOne as jest.Mock).mockClear();
  current = fakeProfile('6aa8d4e65a7a287c0aac87a6');
  mockProfile = current;
});

describe('POST /api/fingerprint — el SO lo pide el cliente', () => {
  it('usa el os que manda el cuerpo y lo guarda en el perfil', async () => {
    const res = await request(makeApp()).post('/api/fingerprint').send({ profileId: current.id, os: 'linux' });

    expect(res.status).toBe(200);
    expect(res.body.os).toBe('linux');
    expect(res.body.osSource).toBe('requested');
    expect(current.os).toBe('linux');
    expect(current.saved).toBe(1);
  });

  it('la segunda petición ya no manda el os: gana el guardado', async () => {
    const app = makeApp();
    await request(app).post('/api/fingerprint').send({ profileId: current.id, os: 'linux' });

    // El cliente vuelve a pedir, esta vez diciendo otra cosa.
    const res = await request(app).post('/api/fingerprint').send({ profileId: current.id, os: 'macos' });

    expect(res.body.os).toBe('linux');
    expect(res.body.osSource).toBe('stored');
    expect(current.os).toBe('linux');
    // Y no vuelve a escribir: si lo hiciera, cada arranque reescribiría el perfil.
    expect(current.saved).toBe(1);
  });

  it('la identidad no cambia entre la primera y la segunda llamada', async () => {
    const app = makeApp();
    const first = await request(app).post('/api/fingerprint').send({ profileId: current.id, os: 'linux' });
    const second = await request(app).post('/api/fingerprint').send({ profileId: current.id });

    expect(second.body.identity).toEqual(first.body.identity);
  });

  it('un os desconocido da 400, no una identidad distinta', async () => {
    // Si se ignorara, un 'Windows' con mayúscula devolvería 200 con un SO
    // distinto del pedido y el fallo aparecería semanas después, como un perfil
    // que "de repente se detecta".
    const res = await request(makeApp()).post('/api/fingerprint').send({ profileId: current.id, os: 'Windows' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Windows');
    expect(current.saved).toBe(0);
  });

  it('sin os y sin nada guardado: sortea y lo fija igual', async () => {
    const res = await request(makeApp()).post('/api/fingerprint').send({ profileId: current.id });

    expect(res.status).toBe(200);
    expect(res.body.os).toBe(autoOs(current.id));
    expect(res.body.osSource).toBe('auto');
    // Se fija también el sorteo: si no, seguiría cambiando en cada petición.
    expect(current.os).toBe(autoOs(current.id));
    expect(current.saved).toBe(1);
  });

  it('acepta la cabecera x-krakenges-platform cuando el cuerpo no trae os', async () => {
    const res = await request(makeApp())
      .post('/api/fingerprint')
      .set('x-krakenges-platform', 'android')
      .send({ profileId: current.id });

    expect(res.body.os).toBe('android');
    expect(res.body.osSource).toBe('device');
  });

  it('un os guardado antes manda también sobre la cabecera', async () => {
    current = fakeProfile(current.id, 'ios');
    mockProfile = current;
    const res = await request(makeApp())
      .post('/api/fingerprint')
      .set('x-krakenges-platform', 'android')
      .send({ profileId: current.id, os: 'macos' });

    expect(res.body.os).toBe('ios');
    expect(res.body.osSource).toBe('stored');
    expect(current.saved).toBe(0);
  });

  it('android e ios ya son alcanzables (antes autoOs no los devolvía nunca)', async () => {
    for (const os of ['android', 'ios'] as const) {
      const p = fakeProfile('6aa8d4e65a7a287c0aac87a6');
      mockProfile = p;
      const res = await request(makeApp()).post('/api/fingerprint').send({ profileId: p.id, os });
      expect(res.body.os).toBe(os);
      expect(res.body.identity.uaOs.toLowerCase()).toContain(os === 'android' ? 'android' : 'iphone');
    }
  });

  it('el país del egress ajusta timezone e idioma juntos, no el SO', async () => {
    const res = await request(makeApp())
      .post('/api/fingerprint')
      .send({ profileId: current.id, os: 'windows', country: 'MX' });

    expect(res.body.identity.timezone).toBe('America/Mexico_City');
    expect(res.body.identity.language).toBe('es-MX');
    expect(res.body.os).toBe('windows');
  });

  it('ignora CF-IPCountry: es el país de la conexión del usuario, no el del proxy', async () => {
    const base = await request(makeApp())
      .post('/api/fingerprint')
      .send({ profileId: current.id, os: 'windows' });
    const res = await request(makeApp())
      .post('/api/fingerprint')
      .set('cf-ipcountry', 'SE')
      .send({ profileId: current.id, os: 'windows' });

    expect(res.body.identity.timezone).toBe(base.body.identity.timezone);
    expect(res.body.identity.language).toBe(base.body.identity.language);
  });

  it('un país con idioma propio no deja el idioma del seed', async () => {
    // Antes el mapa de idiomas no tenía Suecia: el perfil acababa con
    // Europe/Stockholm + el idioma que hubiera salido del seed.
    const res = await request(makeApp())
      .post('/api/fingerprint')
      .send({ profileId: current.id, os: 'windows', country: 'SE' });

    expect(res.body.identity.timezone).toBe('Europe/Stockholm');
    expect(res.body.identity.language).toBe('sv-SE');
  });
});