import type { UserRow } from '../db/schema';

declare global {
  namespace Express {
    interface Request {
      user?: UserRow;
    }
  }
}

export {};
