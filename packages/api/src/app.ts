import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { AppInfoSchema, HealthSchema } from '@taxdesk/shared';
import { resolveRuntimeConfig } from './config.js';
import { createDefaultDependencies, type DependencyFactory } from './dependencies.js';
import { AppInfoService } from './domain/app-info-service.js';
import { HealthService } from './domain/health-service.js';
import { AuthError } from './domain/auth/errors.js';
import {
  requestIdMiddleware,
  requireMutationRequestIdMiddleware,
} from './middleware/request-id.js';
import { dependenciesMiddleware } from './middleware/dependencies.js';
import { originCheckMiddleware, securityHeadersMiddleware } from './middleware/security.js';
import { problemDetailsResponse } from './problem-details.js';
import { authRoutes } from './routes/auth.js';
import { auditRoutes } from './routes/audit.js';
import { caseRoutes } from './routes/cases.js';
import { catalogRoutes } from './routes/catalog.js';
import { clientRoutes } from './routes/clients.js';
import { firmRoutes } from './routes/firm.js';
import { userRoutes } from './routes/users.js';
import type { AppEnv } from './types.js';

export interface CreateAppOptions {
  /**
   * Tests inject an in-memory repository graph. Production uses the default
   * factory, which builds a request-scoped PostgreSQL executor.
   */
  readonly dependencyFactory?: DependencyFactory;
  readonly clock?: () => Date;
}

const PROTECTED_PREFIXES = [
  '/api/v1/auth/*',
  '/api/v1/users/*',
  '/api/v1/admin/*',
  '/api/v1/firm/*',
  // Hono's wildcard also matches the bare `/api/v1/clients` collection path.
  '/api/v1/clients/*',
  '/api/v1/service-types/*',
  '/api/v1/workflow-templates/*',
  '/api/v1/cases/*',
] as const;

function titleForStatus(status: number): string {
  switch (status) {
    case 400:
      return 'Bad Request';
    case 401:
      return 'Unauthorized';
    case 403:
      return 'Forbidden';
    case 404:
      return 'Not Found';
    case 409:
      return 'Conflict';
    case 412:
      return 'Precondition Failed';
    case 428:
      return 'Precondition Required';
    case 429:
      return 'Too Many Requests';
    case 503:
      return 'Service Unavailable';
    default:
      return 'Request Failed';
  }
}

export function createApp(options: CreateAppOptions = {}): Hono<AppEnv> {
  const clock = options.clock ?? (() => new Date());
  const dependencyFactory =
    options.dependencyFactory ?? ((env) => createDefaultDependencies(env, clock));

  const app = new Hono<AppEnv>();

  app.use('*', requestIdMiddleware);
  app.use('*', securityHeadersMiddleware);

  for (const prefix of PROTECTED_PREFIXES) {
    app.use(prefix, dependenciesMiddleware(dependencyFactory));
    app.use(prefix, requireMutationRequestIdMiddleware);
    app.use(prefix, originCheckMiddleware);
  }

  app.get('/health', (c) => {
    const config = resolveRuntimeConfig(c.env);
    const service = new HealthService(config);
    const health = service.getHealth(c.get('requestId'));
    c.header('Cache-Control', 'no-store');
    return c.json(HealthSchema.parse(health));
  });

  app.get('/api/v1/app-info', (c) => {
    const config = resolveRuntimeConfig(c.env);
    const service = new AppInfoService('TaxDesk API', config.releaseVersion, config.environment);
    return c.json(AppInfoSchema.parse(service.getAppInfo()));
  });

  app.route('/api/v1/auth', authRoutes);
  app.route('/api/v1', userRoutes);
  app.route('/api/v1', firmRoutes);
  app.route('/api/v1', auditRoutes);
  app.route('/api/v1', clientRoutes);
  app.route('/api/v1', catalogRoutes);
  app.route('/api/v1', caseRoutes);

  app.notFound((c) => {
    return problemDetailsResponse(c, {
      status: 404,
      code: 'NOT_FOUND',
      title: 'Not Found',
      detail: 'The requested resource was not found.',
    });
  });

  app.onError((err, c) => {
    if (err instanceof AuthError) {
      if (err.retryAfterSeconds !== undefined) {
        c.header('Retry-After', String(err.retryAfterSeconds));
      }
      return problemDetailsResponse(c, {
        status: err.status as ContentfulStatusCode,
        code: err.code,
        title: titleForStatus(err.status),
        detail: err.message,
        ...(err.errors === undefined ? {} : { errors: [...err.errors] }),
      });
    }
    // Structured, allow-listed operational log. Never serialize the raw error,
    // request body, bindings, or provider/database values.
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'api.unhandled_error',
        requestId: c.get('requestId'),
        errorName: err instanceof Error ? err.name : 'UnknownError',
      }),
    );
    return problemDetailsResponse(c, {
      status: 500,
      code: 'INTERNAL_ERROR',
      title: 'Internal Server Error',
      detail: 'The server could not complete the request. Please try again later.',
    });
  });

  return app;
}
