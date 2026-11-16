import type { Request, Response, NextFunction } from 'express';

function isObject(item: unknown): item is Record<string, unknown> {
  return typeof item === 'object' && item !== null && !Array.isArray(item);
}

/**
 * Elimina claves que empiezan por `$` o contienen `.` para que un body no
 * pueda convertirse en un operador de consulta. En PostgreSQL/Drizzle el
 * riesgo es menor que en MongoDB, pero sigue siendo una defensa barata y evita
 * que datos inesperados lleguen a las capas de negocio.
 */
function sanitizeObject(obj: Record<string, unknown>): void {
  for (const key of Object.keys(obj)) {
    if (key.startsWith('$') || key.includes('.')) {
      delete obj[key];
      continue;
    }
    const value = obj[key];
    if (isObject(value)) {
      sanitizeObject(value);
      if (Object.keys(value).length === 0) delete obj[key];
    } else if (Array.isArray(value)) {
      for (const element of value) {
        if (isObject(element)) sanitizeObject(element);
      }
    }
  }
}

export const sanitizeInput = (req: Request, _res: Response, next: NextFunction) => {
  if (isObject(req.body)) sanitizeObject(req.body);
  if (isObject(req.query)) sanitizeObject(req.query as Record<string, unknown>);
  next();
};
