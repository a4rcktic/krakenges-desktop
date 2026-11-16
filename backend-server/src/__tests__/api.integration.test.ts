import express from 'express';
import profilesRouter from '../routes/profiles';
import apikeysRouter from '../routes/apikeys';
import usersRouter from '../routes/users';
import authRouter from '../routes/auth';
import { sanitizeInput } from '../sanitizeMiddleware';
import { errorHandler } from '../errorMiddleware';

function createTestApp() {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use(sanitizeInput);
  app.use('/api/auth', authRouter);
  app.use('/api/profiles', profilesRouter);
  app.use('/api/apikeys', apikeysRouter);
  app.use('/api/users', usersRouter);
  app.use(errorHandler);
  return app;
}

describe('Route modules', () => {
  it('auth router exports a function', () => {
    expect(typeof authRouter).toBe('function');
  });

  it('profiles router exports a function', () => {
    expect(typeof profilesRouter).toBe('function');
  });

  it('apikeys router exports a function', () => {
    expect(typeof apikeysRouter).toBe('function');
  });

  it('users router exports a function', () => {
    expect(typeof usersRouter).toBe('function');
  });

  it('createTestApp returns express app', () => {
    const app = createTestApp();
    expect(app).toBeDefined();
    expect(typeof app.listen).toBe('function');
  });
});

describe('Sanitize middleware', () => {
  it('removes $ from body', () => {
    const req = { body: { name: 'test', evil: { $gt: '' } } } as any;
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as any;
    const next = jest.fn();

    const { sanitizeInput } = require('../sanitizeMiddleware');
    sanitizeInput(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.body.evil).toBeUndefined();
  });

  it('removes $ from nested arrays', () => {
    const req = { body: { items: [{ $where: 'bad' }] } } as any;
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as any;
    const next = jest.fn();

    const { sanitizeInput } = require('../sanitizeMiddleware');
    sanitizeInput(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.body.items[0]).not.toHaveProperty('$where');
  });
});

describe('Error middleware', () => {
  it('errorHandler returns 500', () => {
    const err = new Error('test error');
    const req = {} as any;
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as any;
    const next = jest.fn();

    const { errorHandler } = require('../errorMiddleware');
    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'test error', code: 500 })
    );
  });
});
