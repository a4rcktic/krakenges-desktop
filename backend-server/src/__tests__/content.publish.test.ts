import fs from 'fs';
import os from 'os';
import path from 'path';

const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krakenges-content-'));
const contentFile = path.join(contentDir, 'public-content.json');
process.env.PUBLIC_CONTENT_PATH = contentFile;

function contentModule(): typeof import('../config/publicContent') {
  jest.resetModules();
  return require('../config/publicContent') as typeof import('../config/publicContent');
}

describe('publicación de contenido', () => {
  afterAll(() => {
    fs.rmSync(contentDir, { recursive: true, force: true });
  });

  it('publica, sube la versión y archiva la anterior', async () => {
    const mod = contentModule();
    const saved = await mod.savePublicContent({
      texts: { loginTitle: 'Bienvenido' },
      theme: {
        id: 'halloween',
        version: 1,
        css: 'html[data-theme="halloween"] { --h-orange: #ff7a18; }',
      },
    });

    expect(saved.version).toBe(2);
    expect(saved.texts.loginTitle).toBe('Bienvenido');
    expect(saved.theme.id).toBe('halloween');
    expect(saved.theme.css).toContain('#ff7a18');
    expect(saved.updatedAt).toBeTruthy();
    expect(fs.existsSync(contentFile)).toBe(true);

    const loaded = mod.loadPublicContent();
    expect(loaded.texts.loginTitle).toBe('Bienvenido');

    const history = await mod.listContentHistory();
    expect(history.length).toBe(1);
  });

  it('restaura una versión anterior con una versión nueva', async () => {
    const mod = contentModule();
    await mod.savePublicContent({ texts: { loginTitle: 'Uno' } });
    await mod.savePublicContent({ texts: { loginTitle: 'Dos' } });

    const history = await mod.listContentHistory();
    const previous = history[0];
    expect(previous).toBeTruthy();

    const restored = await mod.revertPublicContent(previous.id);
    expect(restored.texts.loginTitle).toBe('Uno');
    expect(mod.loadPublicContent().texts.loginTitle).toBe('Uno');
    expect(restored.version).toBeGreaterThan(previous.version);
  });

  it('rechaza contenido con formato inválido', () => {
    const mod = contentModule();
    expect(() => mod.previewPublicContent({ texts: { loginTitle: 123 } })).toThrow();
  });

  it('rechaza ids de historial que intentan salir de la carpeta', async () => {
    const mod = contentModule();
    await expect(mod.revertPublicContent('../public-content.json')).rejects.toMatchObject({ statusCode: 400 });
  });
});
