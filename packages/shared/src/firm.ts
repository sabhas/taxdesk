import { z } from 'zod';
import { UuidV7Schema } from './id.js';

/** IANA timezone identifier, e.g. `Asia/Karachi`. */
export const TimezoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(
    /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/,
    'Use an IANA timezone such as Asia/Karachi.',
  );

export const FirmSettingsSchema = z
  .object({
    id: UuidV7Schema,
    firmName: z.string().trim().min(1).max(160),
    timezone: TimezoneSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    version: z.number().int().positive(),
  })
  .strict();

export type FirmSettings = z.infer<typeof FirmSettingsSchema>;

export const FirmSettingsUpdateSchema = z
  .object({
    firmName: z.string().trim().min(1).max(160),
    timezone: TimezoneSchema,
  })
  .strict();

export type FirmSettingsUpdate = z.infer<typeof FirmSettingsUpdateSchema>;
