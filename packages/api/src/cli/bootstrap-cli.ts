import { z } from 'zod';
import {
  DisplayNameSchema,
  UsernameSchema,
  PasswordPolicySchema,
  TimezoneSchema,
} from '@taxdesk/shared';
import { AuthError } from '../domain/auth/errors.js';
import { CliUsageError, parseCliArgs, readValue, type ParsedCliArgs } from './args.js';
import type { CliServices } from './services.js';
import type { Prompt } from './prompt.js';

export const BOOTSTRAP_USAGE = `TaxDesk first-administrator bootstrap

Usage:
  taxdesk-auth-bootstrap [--non-interactive] [options]

Options:
  --firm-name <name>        Firm name (required when non-interactive)
  --username <name>         Administrator username (3–32 letters, digits, . _ -)
  --display-name <name>     Administrator display name
  --password <password>     Password (omit to enter it without echo)
  --timezone <zone>         IANA timezone (default Asia/Karachi)
  --database-url <url>      PostgreSQL URL (default DATABASE_URL)
  --non-interactive         Fail instead of prompting
  --help                    Show this help

The command refuses to run once a firm bootstrap or any administrator exists.`;

const FirmNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^\S(?:[\s\S]*\S)?$/u);

export interface BootstrapCliIo {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly prompt: Prompt;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly now: () => Date;
  readonly createServices: (databaseUrl: string) => CliServices;
}

interface BootstrapInput {
  readonly firmName: string;
  readonly username: string;
  readonly displayName: string;
  readonly password: string;
  readonly timezone: string;
}

function emit(io: BootstrapCliIo, value: unknown): void {
  io.stdout(JSON.stringify(value));
}

function fail(io: BootstrapCliIo, code: string, message: string): void {
  io.stderr(JSON.stringify({ command: 'auth:bootstrap', status: 'failed', code, message }));
}

function validate(input: BootstrapInput): BootstrapInput {
  const firmName = FirmNameSchema.safeParse(input.firmName);
  if (!firmName.success) {
    throw new CliUsageError('Enter a firm name between 1 and 160 characters.');
  }
  const username = UsernameSchema.safeParse(input.username);
  if (!username.success) {
    throw new CliUsageError(username.error.issues[0]?.message ?? 'Enter a valid username.');
  }
  const displayName = DisplayNameSchema.safeParse(input.displayName);
  if (!displayName.success) {
    throw new CliUsageError('Enter a display name between 1 and 120 characters.');
  }
  const password = PasswordPolicySchema.safeParse(input.password);
  if (!password.success) {
    throw new CliUsageError(password.error.issues[0]?.message ?? 'The password is too weak.');
  }
  const timezone = TimezoneSchema.safeParse(input.timezone);
  if (!timezone.success) {
    throw new CliUsageError('Enter an IANA timezone such as Asia/Karachi.');
  }
  return {
    firmName: firmName.data,
    username: username.data,
    displayName: displayName.data,
    password: password.data,
    timezone: timezone.data,
  };
}

const MAX_PROMPT_ATTEMPTS = 3;

/**
 * Re-asks one interactive field until it is valid, so a typo is caught where it
 * was made instead of after the password prompts. Gives up after a few tries.
 */
async function askUntilValid(
  io: BootstrapCliIo,
  ask: () => Promise<string>,
  schema: z.ZodType,
  message: (issues: readonly z.core.$ZodIssue[]) => string,
): Promise<string> {
  let lastMessage = '';
  for (let attempt = 0; attempt < MAX_PROMPT_ATTEMPTS; attempt += 1) {
    const answer = await ask();
    const parsed = schema.safeParse(answer);
    if (parsed.success) {
      return answer;
    }
    lastMessage = message(parsed.error.issues);
    io.stderr(lastMessage);
  }
  throw new CliUsageError(lastMessage);
}

/** Asks for a new password and its confirmation, re-asking both on a mismatch. */
async function askNewPassword(io: BootstrapCliIo): Promise<string> {
  for (let attempt = 0; attempt < MAX_PROMPT_ATTEMPTS; attempt += 1) {
    const password = await askUntilValid(
      io,
      () => io.prompt.askSecret('Password (minimum 12 characters)'),
      PasswordPolicySchema,
      (issues) => issues[0]?.message ?? 'The password is too weak.',
    );
    const confirmation = await io.prompt.askSecret('Confirm password');
    if (confirmation === password) {
      return password;
    }
    io.stderr('The passwords do not match. Enter them again.');
  }
  throw new CliUsageError('The passwords do not match.');
}

async function collectInput(parsed: ParsedCliArgs, io: BootstrapCliIo): Promise<BootstrapInput> {
  const nonInteractive = parsed.flags.has('non-interactive');
  const provided = {
    firmName: readValue(parsed, 'firm-name'),
    username: readValue(parsed, 'username'),
    displayName: readValue(parsed, 'display-name'),
    password: readValue(parsed, 'password'),
    timezone: readValue(parsed, 'timezone') ?? 'Asia/Karachi',
  };

  if (nonInteractive) {
    if (
      provided.firmName === undefined ||
      provided.username === undefined ||
      provided.displayName === undefined ||
      provided.password === undefined
    ) {
      throw new CliUsageError(
        'Non-interactive bootstrap requires --firm-name, --username, --display-name, and --password.',
      );
    }
    return validate({
      firmName: provided.firmName,
      username: provided.username,
      displayName: provided.displayName,
      password: provided.password,
      timezone: provided.timezone,
    });
  }

  const firmName =
    provided.firmName ??
    (await askUntilValid(
      io,
      () => io.prompt.ask('Firm name'),
      FirmNameSchema,
      () => 'Enter a firm name between 1 and 160 characters.',
    ));
  const username =
    provided.username ??
    (await askUntilValid(
      io,
      () => io.prompt.ask('Administrator username'),
      UsernameSchema,
      (issues) => issues[0]?.message ?? 'Enter a valid username.',
    ));
  const displayName =
    provided.displayName ??
    (await askUntilValid(
      io,
      () => io.prompt.ask('Administrator display name'),
      DisplayNameSchema,
      () => 'Enter a display name between 1 and 120 characters.',
    ));
  const password = provided.password ?? (await askNewPassword(io));

  return validate({
    firmName,
    username,
    displayName,
    password,
    timezone: provided.timezone,
  });
}

export async function runBootstrapCli(io: BootstrapCliIo): Promise<number> {
  let parsed: ParsedCliArgs;
  try {
    parsed = parseCliArgs(io.argv);
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n\n${BOOTSTRAP_USAGE}`);
    return 2;
  }

  if (parsed.flags.has('help')) {
    io.stdout(BOOTSTRAP_USAGE);
    return 0;
  }

  const databaseUrl = readValue(parsed, 'database-url') ?? io.env['DATABASE_URL'];
  if (databaseUrl === undefined) {
    io.stderr(`DATABASE_URL or --database-url is required.\n\n${BOOTSTRAP_USAGE}`);
    return 2;
  }

  let services: CliServices | undefined;
  try {
    const input = await collectInput(parsed, io);
    services = io.createServices(databaseUrl);
    const result = await services.bootstrap.bootstrap(input);
    emit(io, {
      command: 'auth:bootstrap',
      status: 'created',
      firmId: result.firmId,
      userId: result.userId,
      username: input.username,
    });
    return 0;
  } catch (error) {
    if (error instanceof CliUsageError) {
      io.stderr(`${error.message}\n\n${BOOTSTRAP_USAGE}`);
      return 2;
    }
    if (error instanceof AuthError) {
      fail(io, error.code, error.message);
      return 1;
    }
    // Never print a raw driver error: it can contain the connection string.
    fail(
      io,
      'COMMAND_FAILED',
      'The bootstrap command did not complete. Check the database connection and try again.',
    );
    return 1;
  } finally {
    io.prompt.close();
    if (services !== undefined) {
      await services.close();
    }
  }
}
