import { z } from 'zod';

/**
 * A request identifier is echoed in every response and embedded in Problem
 * Details. Only a bounded, header-safe character set is accepted so an inbound
 * header cannot inject additional headers or forge log lines.
 */
export const RequestIdSchema = z
  .string()
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export type RequestId = z.infer<typeof RequestIdSchema>;

export const FieldErrorSchema = z
  .object({
    field: z.string().min(1),
    message: z.string().min(1),
  })
  .strict();

export type FieldError = z.infer<typeof FieldErrorSchema>;

/**
 * RFC 9457-style Problem Details with TaxDesk's stable error code, field errors,
 * and request ID extensions. The contract is strict so infrastructure details
 * or provider data cannot be added accidentally.
 */
export const ProblemDetailsSchema = z
  .object({
    type: z.string().min(1),
    title: z.string().min(1),
    status: z.number().int().min(400).max(599),
    code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    detail: z.string().min(1),
    requestId: RequestIdSchema,
    errors: z.array(FieldErrorSchema).min(1).optional(),
  })
  .strict();

export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;
