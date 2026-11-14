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

const MIB = 1024 * 1024;

/**
 * Safe ranges for the business settings an administrator manages in the app
 * (TD-605). The database re-checks every one of them.
 */
export const FIRM_SETTING_LIMITS = {
  /** Currencies invoices can be issued in. Invoices are PKR-only for now. */
  supportedCurrencies: ['PKR'],
  prefixPattern: /^[A-Z]{2,6}$/u,
  documentMaxUploadBytesMin: 1 * MIB,
  documentMaxUploadBytesMax: 250 * MIB,
  dueSoonDaysMin: 1,
  dueSoonDaysMax: 60,
} as const;

export const DEFAULT_FIRM_SETTINGS = {
  currency: 'PKR',
  invoicePrefix: 'INV',
  receiptPrefix: 'RCP',
  documentMaxUploadBytes: 250 * MIB,
  dueSoonDays: 7,
} as const;

export const CurrencySchema = z.enum(['PKR']);

const PrefixSchema = z
  .string()
  .trim()
  .regex(
    FIRM_SETTING_LIMITS.prefixPattern,
    'Use 2 to 6 capital letters, for example INV. Existing numbers keep their prefix.',
  );

const DocumentMaxUploadBytesSchema = z
  .number()
  .int()
  .min(
    FIRM_SETTING_LIMITS.documentMaxUploadBytesMin,
    `Use at least ${String(FIRM_SETTING_LIMITS.documentMaxUploadBytesMin / MIB)} MiB.`,
  )
  .max(
    FIRM_SETTING_LIMITS.documentMaxUploadBytesMax,
    `Use at most ${String(FIRM_SETTING_LIMITS.documentMaxUploadBytesMax / MIB)} MiB.`,
  );

const DueSoonDaysSchema = z
  .number()
  .int('Use a whole number of days.')
  .min(FIRM_SETTING_LIMITS.dueSoonDaysMin, 'Use at least 1 day.')
  .max(FIRM_SETTING_LIMITS.dueSoonDaysMax, 'Use at most 60 days.');

export const FirmSettingsSchema = z
  .object({
    id: UuidV7Schema,
    firmName: z.string().trim().min(1).max(160),
    timezone: TimezoneSchema,
    currency: CurrencySchema,
    invoicePrefix: PrefixSchema,
    receiptPrefix: PrefixSchema,
    documentMaxUploadBytes: DocumentMaxUploadBytesSchema,
    /** Cases due within this many days count as "due soon" everywhere. */
    dueSoonDays: DueSoonDaysSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    version: z.number().int().positive(),
  })
  .strict();

export type FirmSettings = z.infer<typeof FirmSettingsSchema>;

/** Omitted business settings keep their current value. */
export const FirmSettingsUpdateSchema = z
  .object({
    firmName: z.string().trim().min(1).max(160),
    timezone: TimezoneSchema,
    currency: CurrencySchema.optional(),
    invoicePrefix: PrefixSchema.optional(),
    receiptPrefix: PrefixSchema.optional(),
    documentMaxUploadBytes: DocumentMaxUploadBytesSchema.optional(),
    dueSoonDays: DueSoonDaysSchema.optional(),
  })
  .strict();

export type FirmSettingsUpdate = z.infer<typeof FirmSettingsUpdateSchema>;
