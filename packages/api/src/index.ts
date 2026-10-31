import { Hono } from 'hono';
import { AppInfoSchema, HealthSchema } from '@taxdesk/shared';
import { resolveRuntimeConfig } from './config.js';
import { AppInfoService } from './domain/app-info-service.js';
import { HealthService } from './domain/health-service.js';
import { requestIdMiddleware } from './middleware/request-id.js';
import { problemDetailsResponse } from './problem-details.js';
import type { AppEnv } from './types.js';

export type { AppEnv } from './types.js';

const app = new Hono<AppEnv>();

app.use('*', requestIdMiddleware);

app.get('/health', (c) => {
  const config = resolveRuntimeConfig(c.env);
  const service = new HealthService(config);
  const health = service.getHealth(c.get('requestId'));
  c.header('Cache-Control', 'no-store');
  return c.json(HealthSchema.parse(health));
});

app.get('/api/v1/app-info', (c) => {
  const service = new AppInfoService();
  const appInfo = service.getAppInfo();
  const parsed = AppInfoSchema.parse(appInfo);
  return c.json(parsed);
});

app.notFound((c) => {
  return problemDetailsResponse(c, {
    status: 404,
    code: 'NOT_FOUND',
    title: 'Not Found',
    detail: 'The requested resource was not found.',
  });
});

app.onError((err, c) => {
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

export default app;
