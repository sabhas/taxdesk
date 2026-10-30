import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MigrationReportSchema, type MigrationReport } from './contracts.js';
import { MigrationError } from './errors.js';
import {
  EMPTY_MIGRATION_MANIFEST,
  MIGRATION_MANIFEST_FILE,
  parseMigrationManifest,
  planManifestUpdate,
  serializeMigrationManifest,
  verifyMigrationManifest,
} from './manifest.js';
import { createPostgresExecutor, type MigrationDatabase } from './postgres-executor.js';
import { planMigrations, runMigrations } from './runner.js';
import { DirectoryMigrationSource, loadMigrations, type MigrationSource } from './source.js';

const USAGE = `TaxDesk migration runner (forward-only)

Usage:
  migrate up        Apply all pending migrations against DATABASE_URL.
  migrate status    Show applied and pending migrations without writing. --check exits 1 when pending.
  migrate verify    Validate migration files against the committed checksum manifest (no database).
  migrate manifest  Record newly discovered migrations in the manifest; never rewrites history.

Options:
  --database-url <url>  Override the DATABASE_URL environment variable.
  --migrations <dir>    Override the migrations directory.
  --check               Fail (exit 1) when status finds pending migrations.
`;

/** Filesystem and console dependencies, injected so the CLI is testable. */
export interface CliDependencies {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly createExecutor: (connectionString: string) => MigrationDatabase;
  readonly createSource: (directory: string) => MigrationSource;
  readonly readFile: (path: string) => Promise<string>;
  readonly writeFile: (path: string, contents: string) => Promise<void>;
  readonly fileExists: (path: string) => Promise<boolean>;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly stdoutIsTTY?: boolean;
}

/** Migrations directory resolved relative to this module, in source and in dist. */
export const DEFAULT_MIGRATIONS_DIRECTORY = fileURLToPath(
  new URL('../../migrations/', import.meta.url),
);

interface ParsedArguments {
  readonly command: string;
  readonly migrationsDirectory: string;
  readonly databaseUrl: string | undefined;
  readonly check: boolean;
}

class UsageError extends Error {}

function parseArguments(argv: readonly string[], deps: CliDependencies): ParsedArguments {
  let command: string | undefined;
  let migrationsDirectory = DEFAULT_MIGRATIONS_DIRECTORY;
  let databaseUrl = deps.env['DATABASE_URL'];
  let check = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') {
      // Package-manager wrappers may insert an argument separator; ignore it.
      continue;
    } else if (argument === '--database-url') {
      index += 1;
      const value = argv[index];
      if (value === undefined) {
        throw new UsageError('--database-url requires a value.');
      }
      databaseUrl = value;
    } else if (argument === '--migrations') {
      index += 1;
      const value = argv[index];
      if (value === undefined) {
        throw new UsageError('--migrations requires a value.');
      }
      migrationsDirectory = value;
    } else if (argument === '--check') {
      check = true;
    } else if (argument?.startsWith('-')) {
      throw new UsageError(`Unknown option "${argument}".`);
    } else if (command === undefined) {
      command = argument;
    } else {
      throw new UsageError(`Unexpected argument "${String(argument)}".`);
    }
  }

  if (command === undefined) {
    throw new UsageError('A command is required.');
  }

  return { command, migrationsDirectory, databaseUrl, check };
}

function requireDatabaseUrl(databaseUrl: string | undefined): string {
  if (!databaseUrl) {
    throw new UsageError('DATABASE_URL is required (or pass --database-url).');
  }
  return databaseUrl;
}

function emitReport(deps: CliDependencies, report: MigrationReport): void {
  deps.stdout(JSON.stringify(MigrationReportSchema.parse(report)));
}

async function readManifest(directory: string, deps: CliDependencies) {
  const path = join(directory, MIGRATION_MANIFEST_FILE);
  if (!(await deps.fileExists(path))) {
    return EMPTY_MIGRATION_MANIFEST;
  }
  return parseMigrationManifest(await deps.readFile(path));
}

/**
 * Runs one CLI invocation and returns the process exit code: 0 success, 1 a
 * failed check or migration, 2 a usage error. The final stdout line is always a
 * validated JSON report, so CI can parse it without reading human output.
 */
export async function runCli(argv: readonly string[], deps: CliDependencies): Promise<number> {
  let parsed: ParsedArguments;
  try {
    parsed = parseArguments(argv, deps);
  } catch (error) {
    deps.stderr(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return 2;
  }

  const { command, migrationsDirectory, databaseUrl, check } = parsed;
  const source = deps.createSource(migrationsDirectory);

  try {
    switch (command) {
      case 'verify': {
        const files = await loadMigrations(source);
        const manifest = await readManifest(migrationsDirectory, deps);
        const verification = verifyMigrationManifest(files, manifest);
        if (verification.added.length > 0) {
          deps.stderr(
            `Unrecorded migration(s): ${verification.added.join(', ')}. ` +
              'Run `pnpm db:migrate:manifest` and commit the updated manifest.',
          );
          return 1;
        }
        deps.stdout(
          `Verified ${String(verification.files)} migration file(s) against ${MIGRATION_MANIFEST_FILE}.`,
        );
        emitReport(deps, {
          command: 'verify',
          status: 'ok',
          files: verification.files,
          recorded: verification.recorded,
        });
        return 0;
      }

      case 'manifest': {
        const files = await loadMigrations(source);
        const manifest = await readManifest(migrationsDirectory, deps);
        const update = planManifestUpdate(files, manifest);
        if (update.added.length === 0) {
          deps.stdout('Manifest already records every migration.');
          emitReport(deps, {
            command: 'manifest',
            status: 'up_to_date',
            added: [],
            recorded: manifest.migrations.length,
          });
          return 0;
        }
        await deps.writeFile(
          join(migrationsDirectory, MIGRATION_MANIFEST_FILE),
          serializeMigrationManifest(update.manifest),
        );
        deps.stdout(
          `Recorded ${String(update.added.length)} migration(s): ${update.added
            .map((entry) => entry.name)
            .join(', ')}`,
        );
        emitReport(deps, {
          command: 'manifest',
          status: 'updated',
          added: update.added.map((entry) => entry.name),
          recorded: update.manifest.migrations.length,
        });
        return 0;
      }

      case 'status': {
        const executor = deps.createExecutor(requireDatabaseUrl(databaseUrl));
        try {
          const plan = await planMigrations({ executor, source });
          deps.stdout(
            `${String(plan.applied.length)} applied, ${String(plan.pending.length)} pending migration(s).`,
          );
          emitReport(deps, {
            command: 'status',
            status: plan.pending.length === 0 ? 'up_to_date' : 'pending',
            applied: plan.applied,
            pending: plan.pending,
          });
          return check && plan.pending.length > 0 ? 1 : 0;
        } finally {
          await executor.close();
        }
      }

      case 'up': {
        const executor = deps.createExecutor(requireDatabaseUrl(databaseUrl));
        try {
          const result = await runMigrations({
            executor,
            source,
            log: (message) => {
              deps.stdout(message);
            },
          });
          deps.stdout(
            result.applied.length === 0
              ? 'No pending migrations.'
              : `Applied ${String(result.applied.length)} migration(s).`,
          );
          emitReport(deps, {
            command: 'up',
            applied: [...result.applied],
            pending: [...result.pending],
          });
          return 0;
        } finally {
          await executor.close();
        }
      }

      default: {
        deps.stderr(`Unknown command "${command}".\n\n${USAGE}`);
        return 2;
      }
    }
  } catch (error) {
    if (error instanceof UsageError) {
      deps.stderr(`${error.message}\n\n${USAGE}`);
      return 2;
    }
    if (error instanceof MigrationError) {
      deps.stderr(`${error.name} [${error.code}]: ${error.message}`);
      return 1;
    }
    deps.stderr(
      `Migration command failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

function defaultDependencies(): CliDependencies {
  return {
    env: process.env,
    createExecutor: (connectionString) => createPostgresExecutor(connectionString),
    createSource: (directory) => new DirectoryMigrationSource(directory),
    readFile: async (path) => await readFile(path, 'utf8'),
    writeFile: async (path, contents) => {
      await writeFile(path, contents, 'utf8');
    },
    fileExists: async (path) => {
      try {
        await readFile(path);
        return true;
      } catch {
        return false;
      }
    },
    stdout: (line) => {
      process.stdout.write(`${line}\n`);
    },
    stderr: (line) => {
      process.stderr.write(`${line}\n`);
    },
  };
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  process.exitCode = await runCli(process.argv.slice(2), defaultDependencies());
}
