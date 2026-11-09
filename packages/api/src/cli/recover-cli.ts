import { PasswordPolicySchema, UsernameSchema } from '@taxdesk/shared';
import { AuthError } from '../domain/auth/errors.js';
import { CliUsageError, parseCliArgs, readValue, type ParsedCliArgs } from './args.js';
import type { CliServices } from './services.js';
import type { Prompt } from './prompt.js';

export const RECOVERY_USAGE = `TaxDesk offline account recovery

Usage:
  taxdesk-auth-recover [--non-interactive] --username <name> --action <action> [options]

Actions:
  reset-password    Set a new password, revoke sessions, invalidate reset links
  disable-mfa       Remove the TOTP credential and recovery codes, revoke sessions
  reactivate        Reactivate a deactivated account, revoke sessions

Options:
  --username <name>        Account username
  --action <action>        Recovery action
  --password <password>    New password for reset-password (omit to enter without echo)
  --confirm <name>         Required confirmation (the username) when non-interactive
  --database-url <url>     PostgreSQL URL (default DATABASE_URL)
  --non-interactive        Fail instead of prompting
  --help                   Show this help

This command requires deployment-level database access. Every action is audited.`;

const ACTIONS = ['reset-password', 'disable-mfa', 'reactivate'] as const;
type RecoveryAction = (typeof ACTIONS)[number];

export interface RecoveryCliIo {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly prompt: Prompt;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly now: () => Date;
  readonly createServices: (databaseUrl: string) => CliServices;
}

interface RecoveryInput {
  readonly username: string;
  readonly action: RecoveryAction;
  readonly password: string | undefined;
}

function isAction(value: string): value is RecoveryAction {
  return (ACTIONS as readonly string[]).includes(value);
}

async function collectInput(parsed: ParsedCliArgs, io: RecoveryCliIo): Promise<RecoveryInput> {
  const nonInteractive = parsed.flags.has('non-interactive');
  const rawUsername =
    readValue(parsed, 'username') ??
    (nonInteractive ? undefined : await io.prompt.ask('Account username'));
  if (rawUsername === undefined) {
    throw new CliUsageError('--username is required.');
  }
  const username = UsernameSchema.safeParse(rawUsername);
  if (!username.success) {
    throw new CliUsageError('Enter a valid username.');
  }

  const rawAction =
    readValue(parsed, 'action') ??
    (nonInteractive
      ? undefined
      : await io.prompt.ask('Action (reset-password, disable-mfa, reactivate)'));
  if (rawAction === undefined || !isAction(rawAction)) {
    throw new CliUsageError('--action must be reset-password, disable-mfa, or reactivate.');
  }

  let password: string | undefined;
  if (rawAction === 'reset-password') {
    password =
      readValue(parsed, 'password') ??
      (nonInteractive ? undefined : await io.prompt.askSecret('New password'));
    if (password === undefined) {
      throw new CliUsageError('reset-password requires --password or an interactive prompt.');
    }
    if (!nonInteractive) {
      const confirmation = await io.prompt.askSecret('Confirm new password');
      if (confirmation !== password) {
        throw new CliUsageError('The passwords do not match.');
      }
    }
    const policy = PasswordPolicySchema.safeParse(password);
    if (!policy.success) {
      throw new CliUsageError(policy.error.issues[0]?.message ?? 'The password is too weak.');
    }
  }

  return { username: username.data, action: rawAction, password };
}

async function confirm(io: RecoveryCliIo, parsed: ParsedCliArgs, username: string): Promise<void> {
  const nonInteractive = parsed.flags.has('non-interactive');
  if (nonInteractive) {
    const supplied = readValue(parsed, 'confirm');
    if (supplied?.trim().toLowerCase() !== username) {
      throw new CliUsageError(
        'Non-interactive recovery requires --confirm with the exact username.',
      );
    }
    return;
  }
  const answer = await io.prompt.ask(`Type ${username} to confirm`);
  if (answer.trim().toLowerCase() !== username) {
    throw new CliUsageError('Confirmation did not match; no changes were made.');
  }
}

export async function runRecoveryCli(io: RecoveryCliIo): Promise<number> {
  let parsed: ParsedCliArgs;
  try {
    parsed = parseCliArgs(io.argv);
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n\n${RECOVERY_USAGE}`);
    return 2;
  }
  if (parsed.flags.has('help')) {
    io.stdout(RECOVERY_USAGE);
    return 0;
  }
  const databaseUrl = readValue(parsed, 'database-url') ?? io.env['DATABASE_URL'];
  if (databaseUrl === undefined) {
    io.stderr(`DATABASE_URL or --database-url is required.\n\n${RECOVERY_USAGE}`);
    return 2;
  }

  let services: CliServices | undefined;
  try {
    const input = await collectInput(parsed, io);
    await confirm(io, parsed, input.username);
    services = io.createServices(databaseUrl);
    if (input.action === 'reset-password') {
      await services.recovery.resetPassword(input.username, input.password ?? '');
    } else if (input.action === 'disable-mfa') {
      await services.recovery.disableMfa(input.username);
    } else {
      await services.recovery.reactivate(input.username);
    }
    io.stdout(
      JSON.stringify({
        command: 'auth:recover',
        status: 'completed',
        action: input.action,
        username: input.username,
      }),
    );
    return 0;
  } catch (error) {
    if (error instanceof CliUsageError) {
      io.stderr(`${error.message}\n\n${RECOVERY_USAGE}`);
      return 2;
    }
    if (error instanceof AuthError) {
      io.stderr(
        JSON.stringify({
          command: 'auth:recover',
          status: 'failed',
          code: error.code,
          message: error.message,
        }),
      );
      return 1;
    }
    io.stderr(
      JSON.stringify({
        command: 'auth:recover',
        status: 'failed',
        code: 'COMMAND_FAILED',
        message:
          'The recovery command did not complete. Check the database connection and try again.',
      }),
    );
    return 1;
  } finally {
    io.prompt.close();
    if (services !== undefined) {
      await services.close();
    }
  }
}
