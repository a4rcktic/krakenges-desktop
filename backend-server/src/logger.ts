import pino from 'pino';
import path from 'path';
import fs from 'fs';

const LOG_DIR = process.env.LOG_DIR || path.join(process.cwd(), 'logs');
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

const logFiles = {
  app: path.join(LOG_DIR, 'app.log'),
  error: path.join(LOG_DIR, 'error.log'),
  access: path.join(LOG_DIR, 'access.log'),
};

function createProductionLogger() {
  const targets: pino.TransportTargetOptions[] = [
    {
      target: 'pino/file',
      options: { destination: 1, mkdir: true },
      level: LOG_LEVEL,
    },
    {
      target: 'pino/file',
      options: { destination: logFiles.app, mkdir: true, append: true },
      level: LOG_LEVEL,
    },
    {
      target: 'pino/file',
      options: { destination: logFiles.error, mkdir: true, append: true },
      level: 'error',
    },
    {
      target: 'pino/file',
      options: { destination: logFiles.access, mkdir: true, append: true },
      level: 'info',
    },
  ];

  return pino({
    level: LOG_LEVEL,
    transport: { targets },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

function createDevLogger() {
  return pino({
    level: LOG_LEVEL,
    transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export const logger = IS_PRODUCTION ? createProductionLogger() : createDevLogger();

export function createChildLogger(name: string) {
  return logger.child({ module: name });
}

export function setupLogRotation(): void {
  if (!IS_PRODUCTION) return;

  const MAX_ROTATED_FILES = 30;

  const cleanupOldRotatedFiles = (filePath: string) => {
    try {
      const dir = path.dirname(filePath);
      const baseName = path.basename(filePath);
      const files = fs.readdirSync(dir)
        .filter((f) => f.startsWith(baseName + '.'))
        .map((f) => ({
          name: f,
          path: path.join(dir, f),
          time: fs.statSync(path.join(dir, f)).mtime.getTime(),
        }))
        .sort((a, b) => b.time - a.time);

      for (let i = MAX_ROTATED_FILES; i < files.length; i++) {
        fs.unlinkSync(files[i].path);
        logger.info({ file: files[i].path }, 'Old rotated log deleted');
      }
    } catch (err) {
      logger.error({ err }, 'Error cleaning rotated logs');
    }
  };

  const rotateInterval = setInterval(() => {
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    for (const [, filePath] of Object.entries(logFiles)) {
      try {
        if (fs.existsSync(filePath)) {
          const stats = fs.statSync(filePath);
          if (stats.size > 50 * 1024 * 1024) {
            const rotatedPath = `${filePath}.${dateStr}`;
            if (!fs.existsSync(rotatedPath)) {
              fs.renameSync(filePath, rotatedPath);
              logger.info({ file: filePath, rotated: rotatedPath }, 'Log rotated');
              cleanupOldRotatedFiles(filePath);
            }
          }
        }
      } catch (err) {
        logger.error({ err, file: filePath }, 'Error rotating log');
      }
    }
  }, 60 * 60 * 1000);

  rotateInterval.unref();
}
