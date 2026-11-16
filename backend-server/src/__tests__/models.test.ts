import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import User from '../models/User';
import Profile from '../models/Profile';
import BrowserState from '../models/BrowserState';
import LicenseKey from '../models/LicenseKey';
import ApiKey, { storedApiKeyValue } from '../models/ApiKey';
import RefreshToken, { hashRefreshToken, storedRefreshTokenValue } from '../models/RefreshToken';
import ActivityLog from '../models/ActivityLog';

import { connectTestDb, disconnectTestDb, cleanTestDb, hayBaseDeDatos } from './mongoMemory';

const JWT_SECRET = 'test-secret-key-for-integration';

// Estos tests TOCAN la base de datos, así que necesitan una de verdad.
//
// Antes usaban "if (skipIfNoDb()) return;", que salía del describe antes de
// declarar los tests, y Jest contaba eso como APROBADO. Cinco tests que no se
// ejecutan y que reportan verde es peor que no tenerlos.
//
// Ahora la disponibilidad se lee de MONGO_TEST_AVAILABLE, que decide
// jest.globalSetup.js ANTES de que se cargue este fichero. Eso permite usar
// describe.skip de verdad, que el informe muestra como OMITIDO.
//
// Un test omitido se ve en el informe. Un test aprobado sin ejecutar, no.
//
// NO se usa ctx.skip() a propósito: jest decide si la función de un test recibe
// el callback done según cuántos argumentos declara, así que un wrapper con un
// parámetro recibe done y no el contexto, y ctx.skip() no existe. Con
// describe.skip no hace falta ningún truco.
// Los tests que tocan la base de datos se declaran con itBd en lugar de it.
// Si no hay Mongo, quedan OMITIDOS en el informe, que es lo honesto. Con it
// normal fallarian al no poder conectar, y con el "return" de antes se
// contaban como_APROBADOS_.
const itBd = hayBaseDeDatos() ? it : it.skip;

beforeAll(async () => {
  // Si no hay Mongo, connectTestDb lanzaria y la suite entera fallaria. Como en
  // ese caso los 6 tests de BD ya estan marcados como omitidos, aqui solo hace
  // falta no intentar conectar.
  if (hayBaseDeDatos()) await connectTestDb();
});

afterEach(async () => {
  await cleanTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

describe('User Model', () => {
  it('schema has required fields', () => {
    const paths = User.schema.paths;
    expect(paths.name).toBeDefined();
    expect(paths.email).toBeDefined();
    expect(paths.passwordHash).toBeDefined();
    expect(paths.isAdmin).toBeDefined();
    expect(paths.banned).toBeDefined();
    expect(paths.lastLoginAt).toBeDefined();
  });

  itBd('creates a user with required fields', async () => {
    const passwordHash = await bcrypt.hash('testpass123', 10);
    const user = await User.create({ name: 'Test', email: `t-${Date.now()}@test.com`, passwordHash });
    expect(user._id).toBeDefined();
    expect(user.banned).toBe(false);
    expect(user.isAdmin).toBe(false);
  });

  itBd('supports banned and lastLoginAt', async () => {
    const passwordHash = await bcrypt.hash('pass', 10);
    const user = await User.create({ name: 'B', email: `b-${Date.now()}@test.com`, passwordHash, banned: true, lastLoginAt: new Date() });
    expect(user.banned).toBe(true);
    expect(user.lastLoginAt).toBeDefined();
  });
});

describe('Profile Model', () => {
  it('schema has tags, notes, startUrl', () => {
    const paths = Profile.schema.paths;
    expect(paths.tags).toBeDefined();
    expect(paths.notes).toBeDefined();
    expect(paths.startUrl).toBeDefined();
  });

  itBd('creates profile with tags', async () => {
    const user = await User.create({ name: 'U', email: `u-${Date.now()}@test.com`, passwordHash: 'x' });
    const profile = await Profile.create({ userId: user._id, name: 'p1', tags: ['a', 'b'], notes: 'note' });
    expect(profile.tags).toEqual(['a', 'b']);
  });
});

describe('BrowserState Model', () => {
  it('schema has cookies y localStorage, y NO fingerprint', () => {
    const paths = BrowserState.schema.paths;
    expect(paths.cookies).toBeDefined();
    expect(paths.localStorage).toBeDefined();
    // El campo se eliminó el 03/10/2026: la identidad la decide
    // fingerprintService y se sirve en POST /api/fingerprint. Guardar una segunda
    // copia en el servidor era lo que producía el 47,5% de perfiles con dos
    // sistemas operativos distintos.
    expect(paths.fingerprint).toBeUndefined();
  });

  itBd('creates state sin necesidad de una huella', async () => {
    const user = await User.create({ name: 'U', email: `u-${Date.now()}@test.com`, passwordHash: 'x' });
    const profile = await Profile.create({ userId: user._id, name: 'p' });
    const state = await BrowserState.create({
      userId: user._id, profileId: profile._id, cookies: '[]', localStorage: '{}',
    });
    expect(state.cookies).toBe('[]');
    expect((state as any).fingerprint).toBeUndefined();
  });
});

describe('LicenseKey Model', () => {
  it('schema has key, isActive, role, expiresAt', () => {
    const paths = LicenseKey.schema.paths;
    expect(paths.key).toBeDefined();
    expect(paths.isActive).toBeDefined();
    expect(paths.role).toBeDefined();
  });

  itBd('creates active key', async () => {
    const key = await LicenseKey.create({ key: `KEY-${Date.now()}`, isActive: true, role: 'user' });
    expect(key.isActive).toBe(true);
  });
});

describe('ApiKey Model', () => {
  it('schema has key, keyHash, prefix, name, userId', () => {
    const paths = ApiKey.schema.paths;
    expect(paths.key).toBeDefined();
    expect(paths.keyHash).toBeDefined();
    expect(paths.prefix).toBeDefined();
    expect(paths.name).toBeDefined();
    expect(paths.userId).toBeDefined();
    expect(paths.isActive).toBeDefined();
  });

  it('static generateKey returns key, prefix and hash', () => {
    const result = (ApiKey as any).generateKey();
    expect(result.key).toMatch(/^kgs_/);
    expect(result.prefix).toMatch(/^kgs_/);
    expect(result.key.length).toBeGreaterThan(result.prefix.length);
    expect(result.keyHash).toMatch(/^[a-f0-9]{64}$/);
  });

  itBd('creates and finds api key by hash, never by the clear key', async () => {
    const user = await User.create({ name: 'U', email: `u-${Date.now()}@test.com`, passwordHash: 'x' });
    const { key, prefix, keyHash } = (ApiKey as any).generateKey();
    const apiKey = await ApiKey.create({
      userId: user._id,
      name: 'test',
      key: storedApiKeyValue(keyHash),
      keyHash,
      prefix,
    });
    expect(apiKey.isActive).toBe(true);

    const found = await ApiKey.findOne({ keyHash });
    expect(found).toBeDefined();

    const byClearKey = await ApiKey.findOne({ key });
    expect(byClearKey).toBeNull();
  });
});

describe('RefreshToken Model', () => {
  it('hash is deterministic and differs from the token', () => {
    const raw = 'a'.repeat(128);
    const hash = hashRefreshToken(raw);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).toBe(hashRefreshToken(raw));
    expect(storedRefreshTokenValue(hash)).toBe(`sha256:${hash}`);
    expect(storedRefreshTokenValue(hash)).not.toBe(raw);
  });

  itBd('stores the hash, not the clear token', async () => {
    const user = await User.create({ name: 'U', email: `rt-${Date.now()}@test.com`, passwordHash: 'x' });
    const raw = 'b'.repeat(128);
    const tokenHash = hashRefreshToken(raw);

    await RefreshToken.create({
      userId: user._id,
      token: storedRefreshTokenValue(tokenHash),
      tokenHash,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const stored = await RefreshToken.findOne({ tokenHash }).select('+token +tokenHash');
    expect(stored).toBeDefined();
    expect(stored!.token).toBe(storedRefreshTokenValue(tokenHash));
    expect(stored!.tokenHash).toBe(tokenHash);
    expect(stored!.token).not.toBe(raw);
  });
});

describe('ActivityLog Model', () => {
  it('schema has action, entity, entityId, userId', () => {
    const paths = ActivityLog.schema.paths;
    expect(paths.action).toBeDefined();
    expect(paths.entity).toBeDefined();
    expect(paths.entityId).toBeDefined();
    expect(paths.userId).toBeDefined();
  });
});

describe('JWT + bcrypt integration', () => {
  it('password hash and verify works', async () => {
    const hash = await bcrypt.hash('mypassword', 10);
    expect(await bcrypt.compare('mypassword', hash)).toBe(true);
    expect(await bcrypt.compare('wrong', hash)).toBe(false);
  });

  it('jwt sign and verify works', () => {
    const token = jwt.sign({ userId: '123', isAdmin: false }, JWT_SECRET, { expiresIn: '1h' });
    const payload = jwt.verify(token, JWT_SECRET) as any;
    expect(payload.userId).toBe('123');
    expect(payload.isAdmin).toBe(false);
  });

  it('jwt rejects invalid secret', () => {
    const token = jwt.sign({ userId: '123' }, JWT_SECRET, { expiresIn: '1h' });
    expect(() => jwt.verify(token, 'wrong-secret')).toThrow();
  });
});
