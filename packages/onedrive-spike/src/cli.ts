import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  ONEDRIVE_SPIKE_CALLBACK_PATH,
  ONEDRIVE_SPIKE_DEFAULT_PORT,
  ONEDRIVE_SPIKE_SCOPES,
  OnedriveSpikeReportSchema,
  OnedriveSpikeRedirectUriSchema,
  type OnedriveSpikeReport,
  type OnedriveSpikeScenarioResult,
} from '@taxdesk/shared';
import { z } from 'zod';
import { evaluateSpikeResults } from './domain/spike-evaluation.js';
import { AppFolderDriveClient, GraphRequestError } from './graph/graph-client.js';
import {
  GRAPH_PERSONAL_TENANT,
  GraphTokenError,
  buildAuthorizeUrl,
  createPkcePair,
  exchangeAuthorizationCode,
  type GraphOAuthConfig,
  type TokenSet,
} from './graph/oauth.js';
import { runSpikeScenarios } from './harness/scenarios.js';
import { SpikeTokenSession } from './harness/token-session.js';
import { OAuthCallbackError, startLoopbackOAuthServer } from './node/loopback-oauth.js';
import { makeTestFile, nodeRandomBytes, randomHex, sha256Hex } from './node/test-files.js';

/**
 * TD-005 OneDrive Personal feasibility spike CLI.
 *
 * It performs delegated consent through a loopback callback, exercises the six
 * required scenarios against the intended Personal account, and writes a strict,
 * secret-free evidence record that the sprint review notes quote. It is a
 * throwaway harness: nothing here is deployed, persisted, or wired into the
 * product API.
 */

const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url));

/**
 * The CLI is bundled to `<repo>/packages/onedrive-spike/dist/cli.js` and is
 * usually launched through `pnpm --filter`, which sets the working directory to
 * the package folder. Anchoring the default evidence path at the repository root
 * keeps the report where reviewers and the sprint review notes expect it.
 */
const REPOSITORY_ROOT = resolve(MODULE_DIRECTORY, '..', '..', '..');

const DEFAULT_REPORT_PATH = join(
  REPOSITORY_ROOT,
  'docs',
  'product',
  'evidence',
  'td-005-onedrive-spike-report.json',
);

/** Absolute path of the evidence file written when `--report` is omitted. */
export function defaultReportPath(): string {
  return DEFAULT_REPORT_PATH;
}

const DEFAULT_NOTE =
  'Non-production Microsoft application, Personal account, synthetic and non-confidential test files only. No client data was used.';

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

const CliOptionsSchema = z.object({
  clientId: z.string().uuid(),
  host: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[A-Za-z0-9.-]+$/),
  port: z.number().int().min(1024).max(65535),
  reportPath: z.string().min(1).max(400),
  operator: z.string().min(1).max(120),
  skipRevocationCheck: z.boolean(),
  runId: z.string().regex(/^[a-z0-9]{6,32}$/),
});

type CliOptions = z.infer<typeof CliOptionsSchema>;

export type { CliOptions };

const USAGE = `TD-005 OneDrive Personal feasibility spike

Usage:
  pnpm spike:onedrive --client-id <application-id> [options]

Required:
  --client-id <uuid>        Application (client) ID of the non-production Microsoft app registration.
                            Falls back to TAXDESK_MS_GRAPH_CLIENT_ID.

Options:
  --host <host>             Callback host. Default: localhost
  --port <port>             Callback port. Default: ${String(ONEDRIVE_SPIKE_DEFAULT_PORT)}
  --report <path>           Report output path. Default: <repo>/docs/product/evidence/td-005-onedrive-spike-report.json
  --operator <name>         Name recorded in the report. Falls back to TAXDESK_SPIKE_OPERATOR.
  --skip-revocation-check   Skip the revoked-consent scenario (the run then reports an incomplete outcome).
  -h, --help                Show this help.

The redirect URI registered on the app must be exactly
http://<host>:<port>/oauth/callback with the values you pass here.
`;

function toErrorMessage(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues
      .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : 'value'}: ${issue.message}`)
      .join('; ');
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'unknown error';
}

export function resolveCliOptions(argv: readonly string[]): CliOptions | undefined {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        'client-id': { type: 'string' },
        host: { type: 'string' },
        port: { type: 'string' },
        report: { type: 'string' },
        operator: { type: 'string' },
        'skip-revocation-check': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: false,
      strict: true,
    });
  } catch (error) {
    throw new UsageError(toErrorMessage(error));
  }

  const { values } = parsed;
  if (values.help) {
    return undefined;
  }

  const portValue = values.port ?? String(ONEDRIVE_SPIKE_DEFAULT_PORT);
  const candidate = {
    clientId: values['client-id'] ?? process.env['TAXDESK_MS_GRAPH_CLIENT_ID'] ?? '',
    host: values.host ?? 'localhost',
    port: Number.parseInt(portValue, 10),
    reportPath: values.report ?? DEFAULT_REPORT_PATH,
    operator:
      values.operator ??
      process.env['TAXDESK_SPIKE_OPERATOR'] ??
      process.env['USER'] ??
      'unknown-operator',
    skipRevocationCheck: values['skip-revocation-check'],
    runId: randomHex(4),
  };

  const result = CliOptionsSchema.safeParse(candidate);
  if (!result.success) {
    throw new UsageError(toErrorMessage(result.error));
  }

  const redirectUri = `http://${result.data.host}:${String(result.data.port)}${ONEDRIVE_SPIKE_CALLBACK_PATH}`;
  const redirect = OnedriveSpikeRedirectUriSchema.safeParse(redirectUri);
  if (!redirect.success) {
    throw new UsageError(`invalid callback URL: ${toErrorMessage(redirect.error)}`);
  }

  return result.data;
}

interface Prompt {
  announceAuthorization(url: string, redirectUri: string): void;
  confirmRevocation(): Promise<boolean>;
  close(): void;
}

function createPrompt(): Prompt {
  const readline = createInterface({ input: process.stdin, output: process.stdout });

  return {
    announceAuthorization: (url, redirectUri) => {
      process.stdout.write(
        [
          '',
          'Open this URL in a browser and sign in with the intended Personal account:',
          '',
          `  ${url}`,
          '',
          `Waiting for the delegated callback on ${redirectUri} ...`,
          '',
        ].join('\n'),
      );
    },
    confirmRevocation: async () => {
      const answer = await readline.question(
        [
          '',
          'Revoke TaxDesk spike access for this account at',
          '  https://account.live.com/consent/Manage',
          'then press Enter. Type "skip" to leave revoked consent unproven: ',
        ].join('\n'),
      );
      return answer.trim().toLowerCase() !== 'skip';
    },
    close: () => {
      readline.close();
    },
  };
}

interface AuthorizationFlowParams {
  readonly config: GraphOAuthConfig;
  readonly host: string;
  readonly port: number;
  readonly prompt: Prompt;
}

async function runAuthorizationCodeFlow(params: AuthorizationFlowParams): Promise<TokenSet> {
  const pkce = await createPkcePair(nodeRandomBytes);
  const state = randomHex(16);
  const server = await startLoopbackOAuthServer({
    port: params.port,
    host: params.host,
    expectedState: state,
  });

  try {
    const url = buildAuthorizeUrl({
      config: params.config,
      state,
      codeChallenge: pkce.challenge,
      forceConsent: true,
    });
    params.prompt.announceAuthorization(url, server.redirectUri);
    const code = await server.waitForAuthorizationCode();
    return await exchangeAuthorizationCode(fetch, {
      config: params.config,
      code,
      codeVerifier: pkce.verifier,
    });
  } finally {
    await server.close();
  }
}

function describeError(error: unknown): string {
  if (error instanceof UsageError) {
    return error.message;
  }
  if (error instanceof OAuthCallbackError) {
    return `the delegated callback failed with ${error.code}`;
  }
  if (error instanceof GraphTokenError) {
    return `the identity token endpoint rejected the request with ${error.code} (HTTP ${String(error.httpStatus)})`;
  }
  if (error instanceof GraphRequestError) {
    return `Microsoft Graph rejected a request with ${error.code} (HTTP ${String(error.httpStatus)})`;
  }
  const name = error instanceof Error ? error.name : 'UnknownError';
  return `an unexpected ${name} occurred`;
}

interface BuildReportParams {
  readonly options: CliOptions;
  readonly config: GraphOAuthConfig;
  readonly grantedScopes: readonly string[];
  readonly results: readonly OnedriveSpikeScenarioResult[];
  readonly notes?: string;
}

function buildReport(params: BuildReportParams): OnedriveSpikeReport {
  const evaluation = evaluateSpikeResults(params.results);
  return OnedriveSpikeReportSchema.parse({
    reportVersion: 1,
    story: 'TD-005',
    recordedAt: new Date().toISOString(),
    operator: params.options.operator,
    environment: 'non-production',
    accountType: 'personal',
    tenant: GRAPH_PERSONAL_TENANT,
    applicationId: params.options.clientId,
    redirectUri: params.config.redirectUri,
    requestedScopes: [...ONEDRIVE_SPIKE_SCOPES],
    grantedScopes: [...params.grantedScopes],
    results: [...params.results],
    outcome: evaluation.outcome,
    blockingDecision: evaluation.blockingDecision,
    notes: params.notes ?? DEFAULT_NOTE,
  });
}

async function writeReport(reportPath: string, report: OnedriveSpikeReport): Promise<void> {
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function printSummary(report: OnedriveSpikeReport, reportPath: string): void {
  const lines: string[] = ['', 'TD-005 OneDrive Personal feasibility spike', ''];
  for (const result of report.results) {
    const code = result.graphErrorCode === undefined ? '' : ` [${result.graphErrorCode}]`;
    lines.push(
      `  ${result.scenario.padEnd(20)} ${result.status.toUpperCase().padEnd(8)} ${String(result.durationMs).padStart(6)} ms${code}`,
    );
    lines.push(`    ${result.detail}`);
  }
  lines.push('', `  Outcome: ${report.outcome}`);
  if (report.blockingDecision.raised) {
    lines.push('  BLOCKING DECISION RAISED');
    lines.push(`    Reason: ${report.blockingDecision.reason}`);
    lines.push(`    Required action: ${report.blockingDecision.requiredAction}`);
  } else {
    lines.push('  No blocking decision: every required scenario passed.');
  }
  lines.push('', `  Report written to ${reportPath}`, '');
  process.stdout.write(`${lines.join('\n')}\n`);
}

async function main(): Promise<number> {
  const options = resolveCliOptions(process.argv.slice(2));
  if (options === undefined) {
    process.stdout.write(USAGE);
    return 0;
  }

  const config: GraphOAuthConfig = {
    clientId: options.clientId,
    tenant: GRAPH_PERSONAL_TENANT,
    redirectUri: `http://${options.host}:${String(options.port)}${ONEDRIVE_SPIKE_CALLBACK_PATH}`,
  };

  const prompt = createPrompt();
  try {
    let initialTokens: TokenSet;
    try {
      initialTokens = await runAuthorizationCodeFlow({
        config,
        host: options.host,
        port: options.port,
        prompt,
      });
    } catch (error) {
      const detail = describeError(error);
      const report = buildReport({
        options,
        config,
        grantedScopes: [],
        results: [],
        notes: `Delegated consent did not complete: ${detail}.`,
      });
      await writeReport(options.reportPath, report);
      process.stdout.write(
        `\nDelegated consent did not complete: ${detail}\nRecorded an incomplete TD-005 report at ${options.reportPath}.\n`,
      );
      return 1;
    }

    const session = new SpikeTokenSession({
      fetchImpl: fetch,
      config,
      initialTokens,
      skipRevocationCheck: options.skipRevocationCheck,
      confirmRevocation: () => prompt.confirmRevocation(),
      authorizeAgain: () =>
        runAuthorizationCodeFlow({ config, host: options.host, port: options.port, prompt }),
    });

    const drive = new AppFolderDriveClient({
      fetchImpl: fetch,
      getAccessToken: () => session.accessToken,
    });

    const results = await runSpikeScenarios(
      {
        drive,
        tokens: session,
        sha256Hex,
        makeTestFile,
        now: () => Date.now(),
        delay: async (milliseconds) => {
          await new Promise<void>((resolveDelay) => {
            setTimeout(resolveDelay, milliseconds);
          });
        },
        runId: options.runId,
      },
      {
        cleanup: async (itemIds) => {
          for (const itemId of itemIds) {
            await drive.deleteItem(itemId);
          }
        },
      },
    );

    const report = buildReport({
      options,
      config,
      grantedScopes: session.grantedScopes(),
      results,
    });
    await writeReport(options.reportPath, report);
    printSummary(report, options.reportPath);
    return report.outcome === 'passed' ? 0 : 1;
  } finally {
    prompt.close();
  }
}

/**
 * Runs only when this file is the process entry point, so tests can import the
 * option parsing and path helpers without starting a consent flow.
 */
function isProcessEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  return resolve(entry) === fileURLToPath(import.meta.url);
}

if (isProcessEntryPoint()) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(`TD-005 spike could not run: ${describeError(error)}\n`);
    process.exitCode = 1;
  }
}
