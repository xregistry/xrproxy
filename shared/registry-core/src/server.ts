import express, { type Express, type RequestHandler } from 'express';
import type { Server } from 'node:http';

type JsonProvider = unknown | (() => unknown | Promise<unknown>);

export interface RegistryAppOptions {
  readonly model: JsonProvider;
  readonly capabilities: JsonProvider;
  readonly readiness?: () => boolean | Promise<boolean>;
  readonly configure?: (app: Express) => void;
  readonly errorResponse?: (error: unknown) => {
    readonly status: number;
    readonly body: unknown;
  };
}

export interface ListenOptions {
  readonly host: string;
  readonly port: number;
  readonly shutdownTimeoutMs?: number;
  readonly signals?: readonly NodeJS.Signals[];
  readonly onShutdown?: () => void | Promise<void>;
}

function jsonRoute(provider: JsonProvider): RequestHandler {
  return async (_request, response, next) => {
    try {
      const value = typeof provider === 'function' ? await provider() : provider;
      response.json(value);
    } catch (error) {
      next(error);
    }
  };
}

export function createRegistryApp(options: RegistryAppOptions): Express {
  const app = express();
  app.disable('x-powered-by');
  app.get('/health', (_request, response) => response.json({ status: 'ok' }));
  app.get('/ready', async (_request, response, next) => {
    try {
      const ready = await (options.readiness?.() ?? true);
      response.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not-ready' });
    } catch (error) {
      next(error);
    }
  });
  app.get('/model', jsonRoute(options.model));
  app.get('/capabilities', jsonRoute(options.capabilities));
  options.configure?.(app);
  app.use(((error, _request, response, _next) => {
    const mapped = options.errorResponse?.(error) ?? {
      status: 500,
      body: { error: 'internal_server_error' }
    };
    response.status(mapped.status).json(mapped.body);
  }) satisfies express.ErrorRequestHandler);
  return app;
}

export async function listenWithGracefulShutdown(
  app: Express,
  options: ListenOptions
): Promise<{ readonly server: Server; readonly close: () => Promise<void> }> {
  const server = await new Promise<Server>((resolve, reject) => {
    const listening = app.listen(options.port, options.host);
    const onError = (error: Error): void => {
      listening.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      listening.removeListener('error', onError);
      resolve(listening);
    };
    listening.once('error', onError);
    listening.once('listening', onListening);
  });
  let closing: Promise<void> | undefined;
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  const removeSignalHandlers = (): void => {
    for (const [signal, handler] of signalHandlers) {
      process.removeListener(signal, handler);
    }
    signalHandlers.clear();
  };
  const close = (): Promise<void> => {
    if (closing) {
      return closing;
    }
    closing = (async () => {
      let forced = false;
      const closed = new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      });
      const timeout = setTimeout(() => {
        forced = true;
        server.closeAllConnections();
      }, options.shutdownTimeoutMs ?? 10_000);
      let closeError: unknown;
      let shutdownError: unknown;
      try {
        await closed;
      } catch (error) {
        closeError = error;
      } finally {
        clearTimeout(timeout);
      }
      try {
        await options.onShutdown?.();
      } catch (error) {
        shutdownError = error;
      } finally {
        removeSignalHandlers();
      }
      if (shutdownError !== undefined) {
        throw shutdownError;
      }
      if (closeError !== undefined) {
        throw closeError;
      }
      if (forced) {
        throw new Error('Graceful shutdown timed out; active connections were forced closed');
      }
    })();
    return closing;
  };
  const signals = options.signals ?? ['SIGTERM', 'SIGINT'];
  for (const signal of signals) {
    const handler = (): void => {
      void close().catch(error => {
        console.error(error);
        process.exitCode = 1;
      });
    };
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }
  return { server, close };
}
