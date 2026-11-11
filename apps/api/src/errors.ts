import type { ErrorCode } from '@trailpack/shared';

/** Error that is safe to show to API clients. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, 'invalid_input', message, details);
export const unauthorized = (message = 'Chybí nebo je neplatný přístupový token.') => new HttpError(401, 'unauthorized', message);
export const forbidden = (message = 'K této akci nemáte oprávnění.') => new HttpError(403, 'forbidden', message);
export const notFound = (message = 'Záznam nebyl nalezen.') => new HttpError(404, 'not_found', message);

/** Body of every error response. */
export interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}
