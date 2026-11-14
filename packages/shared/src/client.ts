import { z } from 'zod';
import { UuidSchema, UuidV7Schema } from './id.js';

/**
 * Client master-record contracts (Epic 2). Every rule here runs in the browser
 * for field-level feedback and again on the server, which is authoritative.
 *
 * National identifiers (CNIC, NTN) are accepted in requests only. Responses
 * carry a masked form; the API never returns an unmasked identifier.
 */

export const CLIENT_TYPES = ['individual', 'business'] as const;
export const ClientTypeSchema = z.enum(CLIENT_TYPES);
export type ClientType = z.infer<typeof ClientTypeSchema>;

export const CLIENT_STATES = ['active', 'archived'] as const;
export const ClientStateSchema = z.enum(CLIENT_STATES);
export type ClientState = z.infer<typeof ClientStateSchema>;

export const CLIENT_CODE_PATTERN = /^CL-\d{5,}$/u;
export const ClientCodeSchema = z.string().regex(CLIENT_CODE_PATTERN);

/** Server-side client code format: `CL-00042`. Codes are never reused. */
export function formatClientCode(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error('A client code sequence must be a positive integer.');
  }
  return `CL-${String(sequence).padStart(5, '0')}`;
}

export const CLIENT_LIMITS = {
  nameMax: 200,
  notesMax: 4000,
  contactsMax: 10,
  contactNameMax: 120,
  relationshipMax: 80,
  emailMax: 254,
  phoneMax: 32,
  overrideReasonMin: 10,
  overrideReasonMax: 500,
  searchMax: 100,
} as const;

// ---------------------------------------------------------------------------
// Identifier normalization
// ---------------------------------------------------------------------------

function digitsOnly(value: string): string {
  return value.replace(/\D/gu, '');
}

/**
 * CNIC: 13 digits, written `12345-1234567-1` or without separators. Returns
 * the 13 digits, or `null` when the value is not a CNIC.
 */
export function normalizeCnic(value: string): string | null {
  const trimmed = value.trim();
  if (!/^\d{5}-?\d{7}-?\d$/u.test(trimmed)) {
    return null;
  }
  return digitsOnly(trimmed);
}

/**
 * NTN: FBR's 7-digit number with an optional check digit (`1234567-8`), or a
 * 13-digit CNIC-based NTN issued to individuals. Returns the digits, or `null`
 * when the value is not an NTN.
 */
export function normalizeNtn(value: string): string | null {
  const trimmed = value.trim();
  if (/^\d{7}(?:-?\d)?$/u.test(trimmed)) {
    return digitsOnly(trimmed);
  }
  return normalizeCnic(trimmed);
}

export function formatCnic(digits: string): string {
  return `${digits.slice(0, 5)}-${digits.slice(5, 12)}-${digits.slice(12)}`;
}

export function formatNtn(digits: string): string {
  if (digits.length === 8) {
    return `${digits.slice(0, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 13) {
    return formatCnic(digits);
  }
  return digits;
}

/**
 * Masks a formatted identifier, keeping only the last four digits and the
 * separators: `35202-1234567-1` → `•••••-••••567-1`.
 */
export function maskIdentifier(formatted: string, visibleDigits = 4): string {
  const total = digitsOnly(formatted).length;
  let seen = 0;
  let masked = '';
  for (const character of formatted) {
    if (/\d/u.test(character)) {
      seen += 1;
      masked += seen > total - visibleDigits ? character : '•';
    } else {
      masked += character;
    }
  }
  return masked;
}

export const MaskedIdentifierSchema = z.string().regex(/^[•\d-]{7,15}$/u);

// ---------------------------------------------------------------------------
// Name, email, and phone normalization (search and duplicate detection)
// ---------------------------------------------------------------------------

/**
 * Words that do not distinguish one client from another: legal-form suffixes,
 * honorifics, and connectives. "ABC Traders (Pvt.) Ltd." and "abc traders"
 * normalize to the same value.
 */
const NAME_NOISE_WORDS = new Set([
  'the',
  'and',
  'pvt',
  'private',
  'ltd',
  'limited',
  'llc',
  'llp',
  'inc',
  'co',
  'company',
  'corp',
  'corporation',
  'smc',
  'ms',
  'mr',
  'mrs',
  'miss',
  'dr',
]);

/**
 * Normalized client name used for search and for "high-confidence" duplicate
 * warnings: diacritics removed, lowercase, punctuation dropped, legal-form
 * suffixes and honorifics removed, whitespace collapsed.
 */
export function normalizeClientName(value: string): string {
  const base = value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/gu, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  const words = base.split(/\s+/u).filter((word) => word.length > 0);
  const meaningful = words.filter((word) => !NAME_NOISE_WORDS.has(word));
  return (meaningful.length > 0 ? meaningful : words).join(' ');
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Phone numbers are compared as digits in international form. A national
 * Pakistani number (`0300 1234567`) and its international forms
 * (`+92 300 1234567`, `0092…`) normalize to the same `923001234567`.
 */
export function normalizePhone(value: string): string {
  let digits = digitsOnly(value);
  if (digits.startsWith('00')) {
    digits = digits.slice(2);
  } else if (digits.startsWith('0')) {
    digits = `92${digits.slice(1)}`;
  }
  return digits;
}

// ---------------------------------------------------------------------------
// Request contracts
// ---------------------------------------------------------------------------

const NameSchema = z
  .string()
  .trim()
  .min(1, 'Enter a name.')
  .max(CLIENT_LIMITS.nameMax, `Use at most ${String(CLIENT_LIMITS.nameMax)} characters.`);

const OptionalDisplayNameSchema = z
  .string()
  .trim()
  .max(CLIENT_LIMITS.nameMax, `Use at most ${String(CLIENT_LIMITS.nameMax)} characters.`)
  .optional();

export const CnicInputSchema = z
  .string()
  .trim()
  .refine((value) => normalizeCnic(value) !== null, 'Enter a 13-digit CNIC, e.g. 12345-1234567-1.');

export const NtnInputSchema = z
  .string()
  .trim()
  .refine(
    (value) => normalizeNtn(value) !== null,
    'Enter a 7-digit NTN with an optional check digit (1234567-8) or a 13-digit CNIC-based NTN.',
  );

const NotesSchema = z
  .string()
  .max(CLIENT_LIMITS.notesMax, `Use at most ${String(CLIENT_LIMITS.notesMax)} characters.`);

export const ContactEmailSchema = z
  .string()
  .trim()
  .max(CLIENT_LIMITS.emailMax)
  .pipe(z.email('Enter a valid email address.'));

export const ContactPhoneSchema = z
  .string()
  .trim()
  .max(CLIENT_LIMITS.phoneMax, 'Enter a shorter phone number.')
  .regex(/^\+?[\d\s()-]+$/u, 'Use digits, spaces, brackets, hyphens, and an optional leading +.')
  .refine((value) => {
    const digits = digitsOnly(value).length;
    return digits >= 7 && digits <= 15;
  }, 'Enter a phone number with 7 to 15 digits.');

/** Empty optional inputs from forms are sent as absent, never as "". */
export const ClientContactInputSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'Enter the contact name.')
      .max(CLIENT_LIMITS.contactNameMax, 'Use a shorter contact name.'),
    relationship: z
      .string()
      .trim()
      .max(CLIENT_LIMITS.relationshipMax, 'Use a shorter description.')
      .optional(),
    email: ContactEmailSchema.optional(),
    phone: ContactPhoneSchema.optional(),
    isPrimary: z.boolean(),
  })
  .strict()
  .refine((contact) => contact.email !== undefined || contact.phone !== undefined, {
    message: 'Enter an email address or a phone number.',
    path: ['email'],
  });

export type ClientContactInput = z.infer<typeof ClientContactInputSchema>;

const ContactsSchema = z
  .array(ClientContactInputSchema)
  .max(
    CLIENT_LIMITS.contactsMax,
    `Add at most ${String(CLIENT_LIMITS.contactsMax)} contacts per client.`,
  )
  .refine((contacts) => contacts.filter((contact) => contact.isPrimary).length <= 1, {
    message: 'Mark at most one contact as primary.',
  });

export const DuplicateOverrideReasonSchema = z
  .string()
  .trim()
  .min(
    CLIENT_LIMITS.overrideReasonMin,
    `Explain the override in at least ${String(CLIENT_LIMITS.overrideReasonMin)} characters.`,
  )
  .max(CLIENT_LIMITS.overrideReasonMax, 'Use a shorter reason.');

const sharedCreateFields = {
  legalName: NameSchema,
  displayName: OptionalDisplayNameSchema,
  contacts: ContactsSchema,
  notes: NotesSchema.optional(),
  assignedManagerUserId: UuidV7Schema.nullable(),
  /** Required to proceed past non-exact duplicate warnings (manager/admin only). */
  duplicateOverrideReason: DuplicateOverrideReasonSchema.optional(),
};

/**
 * Required fields by client type: an individual is identified by CNIC (NTN
 * optional); a business by NTN and never carries a CNIC.
 */
export const ClientCreateRequestSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('individual'),
      cnic: CnicInputSchema,
      ntn: NtnInputSchema.optional(),
      ...sharedCreateFields,
    })
    .strict(),
  z
    .object({
      type: z.literal('business'),
      ntn: NtnInputSchema,
      ...sharedCreateFields,
    })
    .strict(),
]);

export type ClientCreateRequest = z.infer<typeof ClientCreateRequestSchema>;

const sharedUpdateFields = {
  legalName: NameSchema,
  displayName: OptionalDisplayNameSchema,
  contacts: ContactsSchema,
  notes: NotesSchema,
  assignedManagerUserId: UuidV7Schema.nullable(),
};

/**
 * Full replacement of the editable fields, guarded by `If-Match`. The type
 * cannot change. Identifiers are write-only: omit one to keep the stored
 * value, send a new value to replace it, or (individual NTN only) send `null`
 * to remove it.
 */
export const ClientUpdateRequestSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('individual'),
      cnic: CnicInputSchema.optional(),
      ntn: NtnInputSchema.nullable().optional(),
      ...sharedUpdateFields,
    })
    .strict(),
  z
    .object({
      type: z.literal('business'),
      ntn: NtnInputSchema.optional(),
      ...sharedUpdateFields,
    })
    .strict(),
]);

export type ClientUpdateRequest = z.infer<typeof ClientUpdateRequestSchema>;

/** Duplicate preview: the same shape as a create request, minus the override. */
export const ClientDuplicateCheckRequestSchema = ClientCreateRequestSchema;
export type ClientDuplicateCheckRequest = ClientCreateRequest;

// ---------------------------------------------------------------------------
// Response contracts
// ---------------------------------------------------------------------------

export const ClientContactSchema = z
  .object({
    id: UuidV7Schema,
    name: z.string().min(1).max(CLIENT_LIMITS.contactNameMax),
    relationship: z.string().max(CLIENT_LIMITS.relationshipMax).nullable(),
    email: z.string().max(CLIENT_LIMITS.emailMax).nullable(),
    phone: z.string().max(CLIENT_LIMITS.phoneMax).nullable(),
    isPrimary: z.boolean(),
  })
  .strict();

export type ClientContact = z.infer<typeof ClientContactSchema>;

export const ClientAssigneeSchema = z
  .object({
    id: UuidV7Schema,
    displayName: z.string().min(1).max(120),
  })
  .strict();

export type ClientAssignee = z.infer<typeof ClientAssigneeSchema>;

export const ClientSchema = z
  .object({
    id: UuidV7Schema,
    clientCode: ClientCodeSchema,
    type: ClientTypeSchema,
    legalName: z.string().min(1).max(CLIENT_LIMITS.nameMax),
    displayName: z.string().min(1).max(CLIENT_LIMITS.nameMax),
    cnicMasked: MaskedIdentifierSchema.nullable(),
    ntnMasked: MaskedIdentifierSchema.nullable(),
    contacts: z.array(ClientContactSchema),
    notes: z.string().max(CLIENT_LIMITS.notesMax),
    assignedManager: ClientAssigneeSchema.nullable(),
    state: ClientStateSchema,
    archivedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    version: z.number().int().positive(),
  })
  .strict();

export type Client = z.infer<typeof ClientSchema>;

export const ClientListItemSchema = z
  .object({
    id: UuidV7Schema,
    clientCode: ClientCodeSchema,
    type: ClientTypeSchema,
    legalName: z.string().min(1).max(CLIENT_LIMITS.nameMax),
    displayName: z.string().min(1).max(CLIENT_LIMITS.nameMax),
    cnicMasked: MaskedIdentifierSchema.nullable(),
    ntnMasked: MaskedIdentifierSchema.nullable(),
    primaryContact: ClientContactSchema.nullable(),
    assignedManager: ClientAssigneeSchema.nullable(),
    state: ClientStateSchema,
    updatedAt: z.iso.datetime(),
  })
  .strict();

export type ClientListItem = z.infer<typeof ClientListItemSchema>;

export const ClientListSchema = z
  .object({
    clients: z.array(ClientListItemSchema),
    nextCursor: z.string().min(1).max(512).nullable(),
  })
  .strict();

export type ClientList = z.infer<typeof ClientListSchema>;

export const CLIENT_LIST_STATE_FILTERS = ['active', 'archived', 'all'] as const;

/** Query-string contract for `GET /api/v1/clients`. Archived records are hidden by default. */
export const ClientListQuerySchema = z
  .object({
    q: z
      .string()
      .trim()
      .max(CLIENT_LIMITS.searchMax, 'Use a shorter search.')
      .transform((value) => (value.length === 0 ? undefined : value))
      .optional(),
    type: ClientTypeSchema.optional(),
    /** A user ID, or `unassigned` for clients without a manager. */
    manager: z.union([UuidSchema, z.literal('unassigned')]).optional(),
    state: z.enum(CLIENT_LIST_STATE_FILTERS).default('active'),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict();

export type ClientListQuery = z.infer<typeof ClientListQuerySchema>;

export const ClientAssigneeListSchema = z
  .object({
    assignees: z.array(ClientAssigneeSchema),
  })
  .strict();

export type ClientAssigneeList = z.infer<typeof ClientAssigneeListSchema>;

export const DUPLICATE_MATCH_REASONS = ['cnic', 'ntn', 'email', 'phone', 'name'] as const;
export const DuplicateMatchReasonSchema = z.enum(DUPLICATE_MATCH_REASONS);
export type DuplicateMatchReason = z.infer<typeof DuplicateMatchReasonSchema>;

export const ClientDuplicateMatchSchema = z
  .object({
    clientId: UuidV7Schema,
    clientCode: ClientCodeSchema,
    displayName: z.string().min(1).max(CLIENT_LIMITS.nameMax),
    state: ClientStateSchema,
    reasons: z.array(DuplicateMatchReasonSchema).min(1),
  })
  .strict();

export type ClientDuplicateMatch = z.infer<typeof ClientDuplicateMatchSchema>;

/**
 * `blocking` lists exact identifier matches, which can never be overridden.
 * `warnings` lists email, phone, or normalized-name matches, which a manager
 * or administrator may override with a reason.
 */
export const ClientDuplicateCheckResponseSchema = z
  .object({
    blocking: z.array(ClientDuplicateMatchSchema),
    warnings: z.array(ClientDuplicateMatchSchema),
  })
  .strict();

export type ClientDuplicateCheckResponse = z.infer<typeof ClientDuplicateCheckResponseSchema>;

/** Editable fields named in activity history. Values are never recorded. */
export const CLIENT_FIELDS = [
  'legalName',
  'displayName',
  'cnic',
  'ntn',
  'contacts',
  'notes',
  'assignedManager',
] as const;
export const ClientFieldSchema = z.enum(CLIENT_FIELDS);
export type ClientField = z.infer<typeof ClientFieldSchema>;

export const CLIENT_ACTIVITY_ACTIONS = [
  'client.created',
  'client.updated',
  'client.archived',
  'client.restored',
  'client.duplicate_override',
] as const;
export const ClientActivityActionSchema = z.enum(CLIENT_ACTIVITY_ACTIONS);
export type ClientActivityAction = z.infer<typeof ClientActivityActionSchema>;

/**
 * One entry of a client's activity history. It names the fields that changed
 * and, for national identifiers, only the masked new value; field values,
 * notes, and contact details are never part of the history.
 */
export const ClientActivitySchema = z
  .object({
    id: UuidV7Schema,
    occurredAt: z.iso.datetime(),
    action: ClientActivityActionSchema,
    actor: ClientAssigneeSchema.nullable(),
    changedFields: z.array(ClientFieldSchema),
    cnicMasked: MaskedIdentifierSchema.nullable(),
    ntnMasked: MaskedIdentifierSchema.nullable(),
    overrideReason: z.string().max(CLIENT_LIMITS.overrideReasonMax).nullable(),
  })
  .strict();

export type ClientActivity = z.infer<typeof ClientActivitySchema>;

export const ClientActivityListSchema = z
  .object({
    events: z.array(ClientActivitySchema),
    nextCursor: z.string().min(1).max(128).nullable(),
  })
  .strict();

export type ClientActivityList = z.infer<typeof ClientActivityListSchema>;
