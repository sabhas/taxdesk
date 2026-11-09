import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types.js';
import { DependencyConfigurationError, type DependencyFactory } from '../dependencies.js';
import { problemDetailsResponse } from '../problem-details.js';

/**
 * Builds the request-scoped repository/service graph and always closes the
 * database connection. A missing binding is a public 503, never a stack trace.
 */
export function dependenciesMiddleware(factory: DependencyFactory): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    let dependencies;
    try {
      dependencies = await factory(c.env);
    } catch (error) {
      if (error instanceof DependencyConfigurationError) {
        return problemDetailsResponse(c, {
          status: 503,
          code: 'SERVICE_UNAVAILABLE',
          title: 'Service Unavailable',
          detail: 'TaxDesk is not configured for this environment.',
        });
      }
      throw error;
    }

    c.set('dependencies', dependencies);
    try {
      await next();
    } finally {
      await dependencies.close();
    }
  };
}
