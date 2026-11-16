import type { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Express 4 no captura rechazos de promesas. Sin este wrapper un `await`
 * fallido deja la petición colgada hasta el timeout del cliente y el error no
 * llega al errorHandler.
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
    next: NextFunction,
  ) => Promise<unknown>,
): RequestHandler<P, ResBody, ReqBody, Query> {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
