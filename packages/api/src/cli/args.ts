export interface ParsedCliArgs {
  readonly command: string | undefined;
  readonly values: ReadonlyMap<string, string>;
  readonly flags: ReadonlySet<string>;
}

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

const VALUE_FLAGS = new Set([
  'firm-name',
  'username',
  'display-name',
  'password',
  'timezone',
  'database-url',
  'action',
  'confirm',
]);

const BOOLEAN_FLAGS = new Set(['non-interactive', 'help']);

export function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  let command: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) {
      continue;
    }
    if (!argument.startsWith('--')) {
      if (command !== undefined) {
        throw new CliUsageError(`Unexpected argument "${argument}".`);
      }
      command = argument;
      continue;
    }

    const name = argument.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      flags.add(name);
      continue;
    }
    if (!VALUE_FLAGS.has(name)) {
      throw new CliUsageError(`Unknown option --${name}.`);
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new CliUsageError(`Option --${name} requires a value.`);
    }
    values.set(name, next);
    index += 1;
  }

  return { command, values, flags };
}

export function readValue(parsed: ParsedCliArgs, name: string): string | undefined {
  const value = parsed.values.get(name);
  return value === undefined || value.trim().length === 0 ? undefined : value;
}
