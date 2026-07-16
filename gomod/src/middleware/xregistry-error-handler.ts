/**
 * xRegistry-compliant error handler middleware (RFC 9457 Problem Details).
 *
 * Maps UpstreamError instances from @xregistry/registry-core onto HTTP
 * responses, falling back to a generic 500 for anything else.
 */

import { isUpstreamError } from '../utils/xregistry-errors';
import { NextFunction, Request, Response } from 'express';

export function xregistryErrorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (res.headersSent) return;
  if (isUpstreamError(err)) {
    const status = err.status ?? (err.code === 'not_found' ? 404 : err.code === 'cancelled' ? 503 : 500);
    res.status(status).json({ type: 'about:blank', title: err.message, status, instance: req.originalUrl });
    return;
  }
  const e = err as any;
  const status: number = typeof e?.status === 'number' ? e.status : 500;
  res.status(status).json({ type: 'about:blank', title: e?.title ?? 'Internal Server Error', status, instance: req.originalUrl });
}
