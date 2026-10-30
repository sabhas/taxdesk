import { DeploymentEnvironmentSchema, type DeploymentEnvironment } from '@taxdesk/shared';
import { z } from 'zod';

/**
 * Bindings supplied to the Worker by Wrangler. Non-secret values arrive from
 * `[vars]`; Hyperdrive supplies the pooled database connection string. Secret
 * values are never read by the health endpoint and are not part of this shape.
 */
export interface ApiBindings {
  ENVIRONMENT: DeploymentEnvironment;
  RELEASE_VERSION: string;
  HYPERDRIVE?: {
    connectionString: string;
  };
  [key: string]: unknown;
}

const RuntimeConfigSchema = z.object({
  ENVIRONMENT: DeploymentEnvironmentSchema,
  RELEASE_VERSION: z.string().min(1),
});

export interface RuntimeConfig {
  environment: DeploymentEnvironment;
  releaseVersion: string;
}

/**
 * Validates the deployment configuration required to serve the API. Extra
 * bindings (for example `HYPERDRIVE`) are allowed but stripped, so downstream
 * code can only consume the environment and release version.
 */
export function resolveRuntimeConfig(env: ApiBindings): RuntimeConfig {
  const parsed = RuntimeConfigSchema.parse(env);
  return {
    environment: parsed.ENVIRONMENT,
    releaseVersion: parsed.RELEASE_VERSION,
  };
}
