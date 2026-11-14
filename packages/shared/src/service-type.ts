import { z } from 'zod';
import { UuidV7Schema } from './id.js';

/**
 * Deployment-wide service catalog (Epic 3, TD-301). A case copies the service
 * name and fee when it is opened, so later edits never rewrite history.
 *
 * Money is an integer count of minor units (paisa for PKR).
 */

export const SERVICE_TYPE_LIMITS = {
  nameMax: 120,
  descriptionMax: 1000,
  /** 10 billion rupees, in paisa. */
  feeMaxMinor: 1_000_000_000_000,
  deadlineOffsetMaxDays: 730,
} as const;

/** Minor units per major unit for the firm currency (PKR). */
export const CURRENCY_MINOR_UNITS = 100;
export const FIRM_CURRENCY = 'PKR';

/**
 * What to do when a client already has an active case for the same service
 * and tax year: `warn` asks for an audited reason, `block` refuses.
 */
export const DUPLICATE_CASE_POLICIES = ['warn', 'block'] as const;
export const DuplicateCasePolicySchema = z.enum(DUPLICATE_CASE_POLICIES);
export type DuplicateCasePolicy = z.infer<typeof DuplicateCasePolicySchema>;

export const SERVICE_TYPE_STATES = ['active', 'archived'] as const;
export const ServiceTypeStateSchema = z.enum(SERVICE_TYPE_STATES);
export type ServiceTypeState = z.infer<typeof ServiceTypeStateSchema>;

export const MinorAmountSchema = z
  .number()
  .int('Use whole paisa.')
  .min(0, 'The amount cannot be negative.')
  .max(SERVICE_TYPE_LIMITS.feeMaxMinor, 'The amount is too large.');

/** `150000` → `"1,500.00"`. Display only; never parse this back. */
export function formatMinorAmount(minor: number): string {
  const major = Math.trunc(minor / CURRENCY_MINOR_UNITS);
  const fraction = Math.abs(minor % CURRENCY_MINOR_UNITS);
  return `${major.toLocaleString('en-US')}.${String(fraction).padStart(2, '0')}`;
}

/**
 * Parses a typed amount ("1,500", "1500.5") into minor units without floating
 * point arithmetic. Returns `null` for anything that is not a non-negative
 * amount with at most two decimal places.
 */
export function parseMajorAmount(value: string): number | null {
  const cleaned = value.trim().replace(/,/gu, '');
  const match = /^(\d{1,10})(?:\.(\d{1,2}))?$/u.exec(cleaned);
  if (match === null) {
    return null;
  }
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? '').padEnd(2, '0'));
  return whole * CURRENCY_MINOR_UNITS + fraction;
}

const serviceFields = {
  name: z
    .string()
    .trim()
    .min(1, 'Enter a service name.')
    .max(SERVICE_TYPE_LIMITS.nameMax, 'Use a shorter name.'),
  description: z
    .string()
    .trim()
    .max(SERVICE_TYPE_LIMITS.descriptionMax, 'Use a shorter description.'),
  defaultFeeMinor: MinorAmountSchema,
  defaultDeadlineOffsetDays: z
    .number()
    .int('Use whole days.')
    .min(0, 'Use zero or more days.')
    .max(
      SERVICE_TYPE_LIMITS.deadlineOffsetMaxDays,
      `Use at most ${String(SERVICE_TYPE_LIMITS.deadlineOffsetMaxDays)} days.`,
    ),
  duplicateCasePolicy: DuplicateCasePolicySchema,
  /** Template whose latest published version is suggested for new cases. */
  defaultWorkflowTemplateId: UuidV7Schema.nullable(),
};

export const ServiceTypeCreateRequestSchema = z
  .object({ ...serviceFields, description: serviceFields.description.default('') })
  .strict();

export type ServiceTypeCreateRequest = z.infer<typeof ServiceTypeCreateRequestSchema>;

/** Full replacement of the editable fields, guarded by `If-Match`. */
export const ServiceTypeUpdateRequestSchema = z.object(serviceFields).strict();

export type ServiceTypeUpdateRequest = z.infer<typeof ServiceTypeUpdateRequestSchema>;

export const ServiceTypeSchema = z
  .object({
    id: UuidV7Schema,
    name: z.string().min(1).max(SERVICE_TYPE_LIMITS.nameMax),
    description: z.string().max(SERVICE_TYPE_LIMITS.descriptionMax),
    defaultFeeMinor: MinorAmountSchema,
    defaultDeadlineOffsetDays: z.number().int().min(0),
    duplicateCasePolicy: DuplicateCasePolicySchema,
    defaultWorkflowTemplate: z
      .object({ id: UuidV7Schema, name: z.string().min(1).max(120) })
      .strict()
      .nullable(),
    state: ServiceTypeStateSchema,
    archivedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    version: z.number().int().positive(),
  })
  .strict();

export type ServiceType = z.infer<typeof ServiceTypeSchema>;

export const SERVICE_TYPE_LIST_STATE_FILTERS = ['active', 'archived', 'all'] as const;

export const ServiceTypeListQuerySchema = z
  .object({
    state: z.enum(SERVICE_TYPE_LIST_STATE_FILTERS).default('active'),
  })
  .strict();

export type ServiceTypeListQuery = z.infer<typeof ServiceTypeListQuerySchema>;

/** The catalog is small and deployment-wide, so it is returned whole. */
export const ServiceTypeListSchema = z
  .object({
    serviceTypes: z.array(ServiceTypeSchema),
  })
  .strict();

export type ServiceTypeList = z.infer<typeof ServiceTypeListSchema>;
