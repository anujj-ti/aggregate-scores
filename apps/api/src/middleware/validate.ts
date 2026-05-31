import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';

import { HttpError } from './error-handler.js';

export const validateBody = <Schema extends z.ZodTypeAny>(schema: Schema): RequestHandler => {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const parsed = schema.safeParse(req.body as unknown);
    if (!parsed.success) {
      next(new HttpError(400, parsed.error.issues.map((issue) => issue.message).join('; ')));
      return;
    }
    next();
  };
};

