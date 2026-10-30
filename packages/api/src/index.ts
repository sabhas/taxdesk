import { Hono } from 'hono';
import { AppInfoSchema, HealthSchema } from '@taxdesk/shared';
import type { ApiBindings } from './config.js';
import { resolveRuntimeConfig } from './config.js';
import { AppInfoService } from './domain/app-info-service.js';
import { HealthService } from './domain/health-service.js';

export interface AppEnv {
  Bindings: ApiBindings;
  Variables: {
    requestId: string;
  };
}

const app = new Hono<AppEnv>();

app.use('*', async (c, next) => {
  const requestId = c.req.header('X-Request-Id') ?? crypto.randomUUID();
  c.set('requestId', requestId);
  c.header('X-Request-Id', requestId);
  await next();
});

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
  return c.json(
    {
      error: 'Not Found',
      requestId: c.get('requestId'),
    },
    404,
  );
});

app.onError((err, c) => {
  console.error(`[${c.get('requestId')}]`, err);
  return c.json(
    {
      error: 'Internal Server Error',
      requestId: c.get('requestId'),
    },
    500,
  );
});

export default app;
