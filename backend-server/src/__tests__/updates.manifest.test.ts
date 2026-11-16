import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import updatesRouter from '../routes/updates';

/**
 * Contrato de /api/updates/manifest.
 *
 * No toca Mongo: el endpoint solo lee un fichero. Se usa UPDATER_MANIFEST_PATH
 * para apuntar cada test a un manifiesto temporal y no depender del repositorio.
 */

const app = express();
app.use('/api/updates', updatesRouter);

let temporary: string;
let manifestPath: string;

const rawManifest = {
  version: '1.0.1',
  notes: 'Correcciones de seguridad',
  pub_date: '2026-10-20T12:00:00.000Z',
  platforms: {
    'linux-x86_64': {
      signature: 'linux-signature',
      url: 'https://downloads.example.com/updater/1.0.1/KrakenGes_1.0.1_amd64.AppImage.tar.gz',
    },
    'windows-x86_64': {
      signature: 'windows-signature',
      url: 'https://downloads.example.com/updater/1.0.1/KrakenGes_1.0.1_x64-setup.nsis.zip',
    },
  },
};

function writeManifest(value: unknown) {
  fs.writeFileSync(manifestPath, JSON.stringify(value), 'utf8');
}

beforeEach(() => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'krakenges-updates-'));
  manifestPath = path.join(temporary, 'updater-manifest.json');
  process.env.UPDATER_MANIFEST_PATH = manifestPath;
});

afterEach(() => {
  delete process.env.UPDATER_MANIFEST_PATH;
  fs.rmSync(temporary, { recursive: true, force: true });
});

describe('GET /api/updates/manifest', () => {
  it('devuelve el formato nativo de Tauri para linux-x86_64', async () => {
    writeManifest(rawManifest);

    const res = await request(app).get(
      '/api/updates/manifest?platform=linux&arch=x86_64&current_version=1.0.0',
    );

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      version: '1.0.1',
      notes: 'Correcciones de seguridad',
      pub_date: '2026-10-20T12:00:00.000Z',
      platforms: {
        'linux-x86_64': rawManifest.platforms['linux-x86_64'],
      },
    });
  });

  it('sin target devuelve todas las plataformas para que el plugin elija', async () => {
    writeManifest(rawManifest);

    const res = await request(app).get('/api/updates/manifest');

    expect(res.status).toBe(200);
    expect(res.body.version).toBe('1.0.1');
    expect(res.body.platforms).toEqual(rawManifest.platforms);
  });

  it('sin target sigue respetando current_version', async () => {
    writeManifest(rawManifest);

    const res = await request(app).get(
      '/api/updates/manifest?current_version=1.0.1',
    );

    expect(res.status).toBe(204);
  });

  it('rechaza una plataforma desconocida aunque no haya target válido', async () => {
    writeManifest(rawManifest);

    const res = await request(app).get(
      '/api/updates/manifest?platform=freebsd&arch=x86_64&current_version=0.9.0',
    );

    expect(res.status).toBe(204);
  });

  it('usa el target que manda el plugin y acepta alias win32/x64', async () => {
    writeManifest(rawManifest);

    const porTarget = await request(app).get(
      '/api/updates/manifest?target=windows-x86_64&current_version=0.9.0',
    );
    expect(porTarget.status).toBe(200);
    expect(porTarget.body.platforms).toHaveProperty('windows-x86_64');

    const porAlias = await request(app).get(
      '/api/updates/manifest?platform=win32&arch=x64&current_version=0.9.0',
    );
    expect(porAlias.status).toBe(200);
    expect(porAlias.body.platforms).toEqual({
      'windows-x86_64': rawManifest.platforms['windows-x86_64'],
    });
  });

  it('no ofrece una versión igual o anterior', async () => {
    writeManifest(rawManifest);

    const misma = await request(app).get(
      '/api/updates/manifest?platform=linux&arch=x86_64&current_version=1.0.1',
    );
    expect(misma.status).toBe(204);

    const posterior = await request(app).get(
      '/api/updates/manifest?platform=linux&arch=x86_64&current_version=1.0.2',
    );
    expect(posterior.status).toBe(204);
  });

  it('devuelve 204 si no hay manifiesto desplegado', async () => {
    const res = await request(app).get(
      '/api/updates/manifest?platform=linux&arch=x86_64&current_version=0.9.0',
    );
    expect(res.status).toBe(204);
  });

  it('devuelve 204 para una plataforma que no está en el manifiesto', async () => {
    writeManifest(rawManifest);

    const res = await request(app).get(
      '/api/updates/manifest?platform=darwin&arch=aarch64&current_version=0.9.0',
    );
    expect(res.status).toBe(204);
  });

  it('devuelve 204 si el manifiesto está roto o no tiene firma', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    fs.writeFileSync(manifestPath, '{esto no es json', 'utf8');

    const roto = await request(app).get(
      '/api/updates/manifest?platform=linux&arch=x86_64&current_version=0.9.0',
    );
    expect(roto.status).toBe(204);

    writeManifest({
      ...rawManifest,
      platforms: { 'linux-x86_64': { signature: '', url: rawManifest.platforms['linux-x86_64'].url } },
    });
    const sinFirma = await request(app).get(
      '/api/updates/manifest?platform=linux&arch=x86_64&current_version=0.9.0',
    );
    expect(sinFirma.status).toBe(204);

    consoleError.mockRestore();
  });

  it('omite pub_date si el manifiesto no la trae, en vez de inventarla', async () => {
    const { pub_date: _pubDate, ...sinFecha } = rawManifest;
    writeManifest(sinFecha);

    const res = await request(app).get(
      '/api/updates/manifest?platform=linux&arch=x86_64&current_version=0.9.0',
    );
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('pub_date');
  });

  it('sigue aceptando el formato antiguo normalizado', async () => {
    writeManifest({
      'linux-x86_64': {
        version: '1.0.1',
        notes: 'Formato anterior',
        pub_date: '2026-10-20T12:00:00.000Z',
        signature: 'legacy-signature',
        url: 'https://downloads.example.com/updater/legacy.tar.gz',
      },
    });

    const res = await request(app).get(
      '/api/updates/manifest?platform=linux&arch=x86_64&current_version=0.9.0',
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      version: '1.0.1',
      notes: 'Formato anterior',
      pub_date: '2026-10-20T12:00:00.000Z',
      platforms: {
        'linux-x86_64': {
          signature: 'legacy-signature',
          url: 'https://downloads.example.com/updater/legacy.tar.gz',
        },
      },
    });
  });
});
