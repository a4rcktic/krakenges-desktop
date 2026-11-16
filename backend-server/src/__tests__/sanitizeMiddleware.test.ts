import { NextFunction, Request, Response } from 'express';
import { sanitizeInput } from '../sanitizeMiddleware';

describe('sanitizeInput', () => {
  const createReq = (body: Record<string, unknown>): Partial<Request> => ({
    body,
  });

  const createRes = (): Partial<Response> => ({});

  const createNext = (): NextFunction => {
    const next = jest.fn() as unknown as NextFunction;
    return next;
  };

  it('removes keys starting with $', () => {
    const req = createReq({ '$where': 'evil' }) as Request;
    const res = createRes() as Response;
    const next = createNext();
    sanitizeInput(req, res, next);
    expect(req.body).not.toHaveProperty('$where');
    expect(next).toHaveBeenCalled();
  });

  it('removes keys containing dots', () => {
    const req = createReq({ 'a.b': 'value' }) as Request;
    const res = createRes() as Response;
    const next = createNext();
    sanitizeInput(req, res, next);
    expect(req.body).not.toHaveProperty('a.b');
  });

  it('sanitizes nested objects', () => {
    const req = createReq({ user: { '$gt': '' } }) as Request;
    const res = createRes() as Response;
    const next = createNext();
    sanitizeInput(req, res, next);
    expect((req.body as any).user?.$gt).toBeUndefined();
  });

  it('does not affect valid keys', () => {
    const req = createReq({ name: 'test' }) as Request;
    const res = createRes() as Response;
    const next = createNext();
    sanitizeInput(req, res, next);
    expect(req.body.name).toBe('test');
  });
});
