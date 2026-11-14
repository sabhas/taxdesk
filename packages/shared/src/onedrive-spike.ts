import { z } from 'zod';

/**
 * TD-005 is a feasibility spike rather than a product feature, so these
 * contracts describe the spike evidence record instead of an API payload. They
 * live in the shared package because the CLI that produces the record, the
 * sprint review notes that quote it, and the tests that guard it must agree on
 * exactly one strict shape.
 *
 * A record is committed to the repository, so every free-text and metric value
 * is validated as secret-free before it can be written.
 */

/**
 * The only delegated Microsoft Graph scopes the spike requests.
 *
 * - `Files.ReadWrite.AppFolder` is the narrowest documented Graph permission
 *   that still allows creating, uploading, downloading, and deleting files in
 *   the application's own OneDrive folder. `Files.ReadWrite` and
 *   `Files.ReadWrite.All` grant far more than the document workflow needs.
 * - `offline_access` is required to receive a refresh token, which is the only
 *   way to observe token-refresh and revoked-consent behavior.
 *
 * `User.Read`, `openid`, `profile`, and `email` are deliberately not requested:
 * the spike records the drive it operates on instead of the person consenting.
 */
export const ONEDRIVE_SPIKE_SCOPES = ['offline_access', 'Files.ReadWrite.AppFolder'] as const;

export const OnedriveSpikeScopeSchema = z.enum(ONEDRIVE_SPIKE_SCOPES);

export type OnedriveSpikeScope = z.infer<typeof OnedriveSpikeScopeSchema>;

/**
 * The delegated OAuth callback path registered on the non-production Microsoft
 * application. The port is chosen by the operator but must match the redirect
 * URI registered in the Microsoft Entra portal exactly.
 */
export const ONEDRIVE_SPIKE_CALLBACK_PATH = '/oauth/callback';

export const ONEDRIVE_SPIKE_DEFAULT_PORT = 8788;

export const ONEDRIVE_SPIKE_DEFAULT_REDIRECT_URI = `http://localhost:${String(ONEDRIVE_SPIKE_DEFAULT_PORT)}${ONEDRIVE_SPIKE_CALLBACK_PATH}`;

const LOOPBACK_REDIRECT_URI_PATTERN =
  /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d{2,5}\/oauth\/callback$/;

const HTTPS_REDIRECT_URI_PATTERN = /^https:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\/oauth\/callback$/i;

/**
 * Microsoft only accepts `http` for loopback redirect URIs; every non-loopback
 * callback must be HTTPS. Only the fixed callback path is allowed so a record
 * cannot describe an unregistered or wildcard callback.
 */
export const OnedriveSpikeRedirectUriSchema = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (value) => LOOPBACK_REDIRECT_URI_PATTERN.test(value) || HTTPS_REDIRECT_URI_PATTERN.test(value),
    {
      message:
        'must be a loopback http://<host>:<port>/oauth/callback or an https://<host>/oauth/callback URL',
    },
  );

/**
 * The scenarios the sprint review notes must record. Every one of them is
 * required before Epic 4 document storage may depend on OneDrive Personal.
 */
export const ONEDRIVE_SPIKE_SCENARIOS = [
  'consent',
  'token_refresh',
  'upload',
  'download',
  'upload_interruption',
  'revoked_consent',
] as const;

export const OnedriveSpikeScenarioSchema = z.enum(ONEDRIVE_SPIKE_SCENARIOS);

export type OnedriveSpikeScenario = z.infer<typeof OnedriveSpikeScenarioSchema>;

export const ONEDRIVE_SPIKE_REQUIRED_SCENARIOS: readonly OnedriveSpikeScenario[] =
  ONEDRIVE_SPIKE_SCENARIOS;

export const OnedriveSpikeScenarioStatusSchema = z.enum(['passed', 'failed', 'skipped']);

export type OnedriveSpikeScenarioStatus = z.infer<typeof OnedriveSpikeScenarioStatusSchema>;

/**
 * Patterns that would indicate a provider token, authorization code, or secret
 * leaked into a record. A committed evidence file must never contain them.
 */
const SPIKE_SECRET_PATTERNS: readonly RegExp[] = [
  /\bbearer\s+[A-Za-z0-9._~+/-]{16,}/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /(?:access_token|refresh_token|id_token|client_secret|code_verifier|authorization_code)/i,
  /[A-Za-z0-9_~+/-]{80,}={0,2}/,
];

export function containsSpikeSecret(value: string): boolean {
  return SPIKE_SECRET_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Free text that is safe to commit: no tokens, authorization codes, client
 * secrets, or long opaque values. 64-character digests stay allowed because the
 * spike records SHA-256 checksums as file evidence.
 */
export function spikeSafeText(maxLength: number) {
  return z
    .string()
    .min(1)
    .max(maxLength)
    .refine((value) => !containsSpikeSecret(value), {
      message: 'must not contain provider tokens, authorization codes, or secrets',
    });
}

export const SpikeSafeTextSchema = spikeSafeText(2000);

export type SpikeSafeText = z.infer<typeof SpikeSafeTextSchema>;

/**
 * Observed measurements such as file sizes, token lifetimes, and chunk offsets.
 * Keys are dotted lower-camel identifiers so the record stays readable, and
 * string values are held to the same secret-free rule as free text.
 */
export const SPIKE_METRIC_KEY_PATTERN = /^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)*$/;

export const SpikeMetricValueSchema = z.union([
  // Zod 4 numbers reject Infinity and NaN by default.
  z.number(),
  z.boolean(),
  z
    .string()
    .min(1)
    .max(200)
    .refine((value) => !containsSpikeSecret(value)),
]);

export const SpikeMetricsSchema = z.record(
  z.string().regex(SPIKE_METRIC_KEY_PATTERN).max(60),
  SpikeMetricValueSchema,
);

export type SpikeMetrics = z.infer<typeof SpikeMetricsSchema>;

export const OnedriveSpikeScenarioResultSchema = z
  .object({
    scenario: OnedriveSpikeScenarioSchema,
    status: OnedriveSpikeScenarioStatusSchema,
    durationMs: z.number().int().min(0),
    httpStatus: z.number().int().min(100).max(599).optional(),
    graphErrorCode: spikeSafeText(120).optional(),
    detail: SpikeSafeTextSchema,
    metrics: SpikeMetricsSchema.optional(),
  })
  .strict();

export type OnedriveSpikeScenarioResult = z.infer<typeof OnedriveSpikeScenarioResultSchema>;

export const OnedriveSpikeOutcomeSchema = z.enum(['passed', 'failed', 'incomplete']);

export type OnedriveSpikeOutcome = z.infer<typeof OnedriveSpikeOutcomeSchema>;

/**
 * A raised blocking decision stops Epic 4 document storage and any production
 * OneDrive adapter work. The discriminated union keeps a non-blocking record
 * from carrying a stale reason or action.
 */
export const OnedriveSpikeBlockingDecisionSchema = z.discriminatedUnion('raised', [
  z.object({ raised: z.literal(false) }).strict(),
  z
    .object({
      raised: z.literal(true),
      reason: SpikeSafeTextSchema,
      requiredAction: SpikeSafeTextSchema,
    })
    .strict(),
]);

export type OnedriveSpikeBlockingDecision = z.infer<typeof OnedriveSpikeBlockingDecisionSchema>;

/**
 * The committed spike record. The contract is strict so an operator cannot
 * append an unvetted field, and scenario entries are unique so a result cannot
 * be counted twice.
 */
export const OnedriveSpikeReportSchema = z
  .object({
    reportVersion: z.literal(1),
    story: z.literal('TD-005'),
    recordedAt: z.iso.datetime(),
    operator: spikeSafeText(120),
    environment: z.literal('non-production'),
    accountType: z.literal('personal'),
    tenant: z.literal('consumers'),
    applicationId: z.uuid(),
    redirectUri: OnedriveSpikeRedirectUriSchema,
    requestedScopes: z.array(OnedriveSpikeScopeSchema).min(1).max(ONEDRIVE_SPIKE_SCOPES.length),
    grantedScopes: z.array(spikeSafeText(120)).max(20),
    results: z.array(OnedriveSpikeScenarioResultSchema).max(ONEDRIVE_SPIKE_SCENARIOS.length),
    outcome: OnedriveSpikeOutcomeSchema,
    blockingDecision: OnedriveSpikeBlockingDecisionSchema,
    notes: SpikeSafeTextSchema.optional(),
  })
  .strict()
  .superRefine((report, ctx) => {
    const seen = new Set<OnedriveSpikeScenario>();
    for (const [index, result] of report.results.entries()) {
      if (seen.has(result.scenario)) {
        ctx.addIssue({
          code: 'custom',
          path: ['results', index, 'scenario'],
          message: 'scenario results must be unique',
        });
      }
      seen.add(result.scenario);
    }
  });

export type OnedriveSpikeReport = z.infer<typeof OnedriveSpikeReportSchema>;
