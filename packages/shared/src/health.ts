import { z } from 'zod';

/**
 * The deployment environment a runtime is configured for. One deployment serves
 * exactly one firm, so this is deployment metadata rather than request input.
 */
export const DeploymentEnvironmentSchema = z.enum(['development', 'staging', 'production']);

export type DeploymentEnvironment = z.infer<typeof DeploymentEnvironmentSchema>;

/**
 * Public health payload. The contract is intentionally strict: the response may
 * contain environment, release version, and request ID only. It must never
 * include secrets, database names, connection details, or infrastructure
 * addresses, so unknown keys are rejected during validation.
 */
export const HealthSchema = z
  .object({
    environment: DeploymentEnvironmentSchema,
    releaseVersion: z.string().min(1),
    requestId: z.string().min(1),
  })
  .strict();

export type Health = z.infer<typeof HealthSchema>;
