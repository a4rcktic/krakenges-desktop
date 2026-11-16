import { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Envuelve un handler `async` para que sus errores lleguen al `errorHandler`.
 *
 * POR QUÉ ESTO EXISTE
 *
 * Express 4 no captura los rechazos de promesa de un handler async. Si un
 * `await` falla y nadie hace catch, la excepción se convierte en un
 * `unhandledRejection` y la petición se queda colgada hasta que el cliente
 * agota su timeout: el usuario ve "cargando" indefinido y el servidor no registra
 * nada. El `errorHandler` de errorMiddleware.ts, que ya existe y está bien
 * escrito, nunca llega a ejecutarse en ese caso.
 *
 * Antes de esto había 9 `try/catch` en 63 endpoints: casi todos los handlers
 * async dependían de que nada fallara. Este wrapper hace que el fallo se
 * traduzca siempre en una respuesta HTTP con el mensaje correcto.
 *
 * A partir de Express 5 esto deja de ser necesario (el núcleo ya lo hace), así
 * que el wrapper es también el punto donde Migrar.
 */
export function asyncHandler<
  P = Record<string, string>,
  ResBody = any,
  ReqBody = any,
  Query = Record<string, any>,
>(
  fn: (
    req: Request<P, ResBody, ReqBody, Query>,
    res: Response<ResBody>,
    next: NextFunction
  ) => Promise<unknown>
): RequestHandler<P, ResBody, ReqBody, Query> {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

/**
 * Error con código HTTP, para lo que se quiere responder con un status concreto
 * en vez de un 500 genérico.
 *
 *   throw new HttpError(404, 'Perfil no encontrado')
 *
 * El `errorHandler` ya lee `statusCode`.
 */
export class HttpError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.name = 'HttpError';
  }
}