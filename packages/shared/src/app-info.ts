import { z } from 'zod';

export const AppInfoSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  environment: z.enum(['development', 'staging', 'production']),
});

export type AppInfo = z.infer<typeof AppInfoSchema>;
