export type UpstreamErrorCode =
  | 'not_found'
  | 'rate_limited'
  | 'timeout'
  | 'network'
  | 'server_error'
  | 'invalid_response'
  | 'cancelled';

export interface UpstreamErrorOptions {
  readonly code: UpstreamErrorCode;
  readonly message: string;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly retryable?: boolean;
  readonly cause?: unknown;
  readonly details?: Readonly<Record<string, unknown>>;
}

export class UpstreamError extends Error {
  readonly code: UpstreamErrorCode;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(options: UpstreamErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = 'UpstreamError';
    this.code = options.code;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export function isUpstreamError(error: unknown): error is UpstreamError {
  return error instanceof UpstreamError;
}

export interface UpstreamClient<TRequest, TResponse> {
  execute(request: TRequest): Promise<TResponse>;
}

export type ErrorBoundary<T> = (error: unknown) => T;

export function withErrorBoundary<TRequest, TResponse>(
  client: UpstreamClient<TRequest, TResponse>,
  normalize: ErrorBoundary<UpstreamError> = normalizeUnknownError
): UpstreamClient<TRequest, TResponse> {
  return {
    async execute(request: TRequest): Promise<TResponse> {
      try {
        return await client.execute(request);
      } catch (error) {
        throw normalize(error);
      }
    }
  };
}

export function normalizeUnknownError(error: unknown): UpstreamError {
  if (isUpstreamError(error)) {
    return error;
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new UpstreamError({
      code: 'cancelled',
      message: 'Upstream request was cancelled',
      cause: error
    });
  }
  return new UpstreamError({
    code: 'network',
    message: error instanceof Error ? error.message : 'Unknown upstream failure',
    retryable: true,
    cause: error
  });
}
