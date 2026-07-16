import { UpstreamError } from './errors';

export interface ConditionalRequest {
  readonly etag?: string;
  readonly lastModified?: string;
}

export interface HttpClientOptions {
  /** Maximum duration of one fetch attempt, including response parsing. */
  readonly timeoutMs?: number;
  /** Maximum duration from request admission through queueing, retries, and backoff. */
  readonly operationTimeoutMs?: number;
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly jitterRatio?: number;
  readonly concurrency?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly random?: () => number;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export interface HttpRequest<T> {
  readonly url: string | URL;
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly conditional?: ConditionalRequest;
  readonly body?: BodyInit;
  readonly parse: (response: Response) => Promise<T>;
  readonly signal?: AbortSignal;
  readonly retry?: boolean;
}

export interface HttpResponse<T> {
  readonly status: number;
  readonly value: T;
  readonly etag?: string;
  readonly lastModified?: string;
}

export interface NotModifiedResponse {
  readonly status: 304;
  readonly notModified: true;
  readonly etag?: string;
  readonly lastModified?: string;
}

export type ConditionalHttpResponse<T> = HttpResponse<T> | NotModifiedResponse;

interface Waiter {
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
}

class Semaphore {
  private active = 0;
  private readonly waiting: Waiter[] = [];

  constructor(private readonly limit: number) {}

  async run<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      return await operation();
    } finally {
      this.release();
    }
  }

  private async acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      throw signal.reason;
    }
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.waiting.indexOf(waiter);
        if (index >= 0) {
          this.waiting.splice(index, 1);
        }
        reject(signal.reason);
      };
      const waiter: Waiter = { resolve, reject, signal, onAbort };
      this.waiting.push(waiter);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) {
      next.signal.removeEventListener('abort', next.onAbort);
      next.resolve();
      return;
    }
    this.active -= 1;
  }
}

function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function responseHeaders(response: Response): Pick<HttpResponse<never>, 'etag' | 'lastModified'> {
  const etag = response.headers.get('etag') ?? undefined;
  const lastModified = response.headers.get('last-modified') ?? undefined;
  return {
    ...(etag === undefined ? {} : { etag }),
    ...(lastModified === undefined ? {} : { lastModified })
  };
}

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timeout = setTimeout(finish, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    function finish(): void {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function raceWithAbort<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
  onAbort?: () => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      onAbort?.();
      reject(signal.reason);
      return;
    }
    const handleAbort = (): void => {
      onAbort?.();
      reject(signal.reason);
    };
    signal.addEventListener('abort', handleAbort, { once: true });
    let result: Promise<T>;
    try {
      result = operation();
    } catch (error) {
      signal.removeEventListener('abort', handleAbort);
      reject(error);
      return;
    }
    result.then(
      value => {
        signal.removeEventListener('abort', handleAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', handleAbort);
        reject(error);
      }
    );
  });
}

export class HttpUpstreamClient {
  private readonly timeoutMs: number;
  private readonly operationTimeoutMs: number;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly jitterRatio: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly random: () => number;
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly semaphore: Semaphore;

  constructor(options: HttpClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.operationTimeoutMs = options.operationTimeoutMs ?? 30_000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 100;
    this.maxDelayMs = options.maxDelayMs ?? 2_000;
    this.jitterRatio = options.jitterRatio ?? 0.2;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? defaultSleep;
    this.semaphore = new Semaphore(options.concurrency ?? 16);

    if (
      this.timeoutMs <= 0 ||
      this.operationTimeoutMs <= 0 ||
      this.maxAttempts < 1 ||
      (options.concurrency ?? 16) < 1
    ) {
      throw new Error('timeoutMs, operationTimeoutMs, maxAttempts, and concurrency must be positive');
    }
    if (this.jitterRatio < 0 || this.jitterRatio > 1) {
      throw new Error('jitterRatio must be between 0 and 1');
    }
  }

  request<T>(request: HttpRequest<T>): Promise<ConditionalHttpResponse<T>> {
    const operationController = new AbortController();
    const timeout = setTimeout(
      () => operationController.abort(new Error('operation timeout')),
      this.operationTimeoutMs
    );
    const signal = request.signal
      ? AbortSignal.any([request.signal, operationController.signal])
      : operationController.signal;

    return this.semaphore
      .run(
        () => this.requestWithRetry(request, signal, operationController.signal),
        signal
      )
      .catch(error => {
        throw this.normalizeAbortOrNetworkError(
          error,
          request.signal,
          operationController.signal
        );
      })
      .finally(() => clearTimeout(timeout));
  }

  async getJson<T>(
    url: string | URL,
    options: Omit<HttpRequest<T>, 'url' | 'method' | 'parse'> = {}
  ): Promise<ConditionalHttpResponse<T>> {
    return this.request({
      ...options,
      url,
      method: 'GET',
      parse: async response => response.json() as Promise<T>
    });
  }

  private async requestWithRetry<T>(
    request: HttpRequest<T>,
    operationSignal: AbortSignal,
    operationTimeoutSignal: AbortSignal
  ): Promise<ConditionalHttpResponse<T>> {
    let lastError: UpstreamError | undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        return await this.requestOnce(request, operationSignal, operationTimeoutSignal);
      } catch (error) {
        lastError = error instanceof UpstreamError
          ? error
          : this.normalizeAbortOrNetworkError(error, request.signal, operationTimeoutSignal);
        if (!lastError.retryable || !this.canRetry(request) || attempt === this.maxAttempts) {
          throw lastError;
        }
        await this.sleep(this.retryDelay(attempt, lastError.retryAfterMs), operationSignal);
      }
    }
    throw lastError ?? new UpstreamError({ code: 'network', message: 'Upstream request failed' });
  }

  private async requestOnce<T>(
    request: HttpRequest<T>,
    operationSignal: AbortSignal,
    operationTimeoutSignal: AbortSignal
  ): Promise<ConditionalHttpResponse<T>> {
    const attemptController = new AbortController();
    const timeout = setTimeout(
      () => attemptController.abort(new Error('attempt timeout')),
      this.timeoutMs
    );
    const signal = AbortSignal.any([operationSignal, attemptController.signal]);
    const headers = new Headers(request.headers);
    if (request.conditional?.etag) {
      headers.set('if-none-match', request.conditional.etag);
    }
    if (request.conditional?.lastModified) {
      headers.set('if-modified-since', request.conditional.lastModified);
    }

    try {
      let response: Response;
      try {
        response = await this.fetchImpl(request.url, {
          method: request.method ?? 'GET',
          headers,
          ...(request.body === undefined ? {} : { body: request.body }),
          signal
        });
      } catch (error) {
        throw this.normalizeAbortOrNetworkError(
          error,
          request.signal,
          operationTimeoutSignal,
          attemptController.signal
        );
      }
      if (signal.aborted) {
        throw this.normalizeAbortOrNetworkError(
          signal.reason,
          request.signal,
          operationTimeoutSignal,
          attemptController.signal
        );
      }

      const metadata = responseHeaders(response);
      if (response.status === 304) {
        return { status: 304, notModified: true, ...metadata };
      }
      if (response.status === 404) {
        await response.body?.cancel();
        throw new UpstreamError({
          code: 'not_found',
          message: 'Upstream resource was not found',
          status: 404
        });
      }
      if (response.status === 429) {
        const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
        await response.body?.cancel();
        throw new UpstreamError({
          code: 'rate_limited',
          message: 'Upstream rate limit exceeded',
          status: 429,
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
          retryable: true
        });
      }
      if (response.status >= 500) {
        await response.body?.cancel();
        throw new UpstreamError({
          code: 'server_error',
          message: `Upstream returned HTTP ${response.status}`,
          status: response.status,
          retryable: true
        });
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new UpstreamError({
          code: 'invalid_response',
          message: `Unexpected upstream HTTP ${response.status}`,
          status: response.status
        });
      }

      try {
        const value = await raceWithAbort(
          () => request.parse(response),
          signal,
          () => {
            void response.body?.cancel().catch(() => undefined);
          }
        );
        if (signal.aborted) {
          throw signal.reason;
        }
        return {
          status: response.status,
          value,
          ...metadata
        };
      } catch (error) {
        if (
          attemptController.signal.aborted ||
          operationSignal.aborted ||
          request.signal?.aborted
        ) {
          throw this.normalizeAbortOrNetworkError(
            error,
            request.signal,
            operationTimeoutSignal,
            attemptController.signal
          );
        }
        throw new UpstreamError({
          code: 'invalid_response',
          message: 'Unable to parse upstream response',
          status: response.status,
          cause: error
        });
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  private normalizeFetchError(error: unknown): UpstreamError {
    return new UpstreamError({
      code: 'network',
      message: error instanceof Error ? error.message : 'Upstream network failure',
      retryable: true,
      cause: error
    });
  }

  private normalizeAbortOrNetworkError(
    error: unknown,
    callerSignal: AbortSignal | undefined,
    operationTimeoutSignal: AbortSignal,
    attemptTimeoutSignal?: AbortSignal
  ): UpstreamError {
    if (callerSignal?.aborted) {
      return new UpstreamError({
        code: 'cancelled',
        message: 'Upstream request was cancelled',
        cause: error
      });
    }
    if (operationTimeoutSignal.aborted) {
      return new UpstreamError({
        code: 'timeout',
        message: `Upstream operation timed out after ${this.operationTimeoutMs}ms`,
        retryable: false,
        cause: error,
        details: { scope: 'operation' }
      });
    }
    if (attemptTimeoutSignal?.aborted) {
      return new UpstreamError({
        code: 'timeout',
        message: `Upstream attempt timed out after ${this.timeoutMs}ms`,
        retryable: true,
        cause: error,
        details: { scope: 'attempt' }
      });
    }
    if (error instanceof UpstreamError) {
      return error;
    }
    return this.normalizeFetchError(error);
  }

  private retryDelay(attempt: number, retryAfterMs?: number): number {
    if (retryAfterMs !== undefined) {
      return Math.min(retryAfterMs, this.maxDelayMs);
    }
    const exponential = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (attempt - 1));
    const factor = 1 - this.jitterRatio + this.random() * this.jitterRatio * 2;
    return Math.max(0, Math.round(exponential * factor));
  }

  private canRetry<T>(request: HttpRequest<T>): boolean {
    if (request.retry !== undefined) {
      return request.retry;
    }
    return ['GET', 'HEAD', 'OPTIONS'].includes((request.method ?? 'GET').toUpperCase());
  }
}
