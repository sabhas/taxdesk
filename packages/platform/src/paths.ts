import { resolve } from 'node:path';

/**
 * Resolves a file path the operator typed on the command line.
 *
 * The CLIs run through `pnpm --filter @taxdesk/platform`, so the process
 * working directory is `packages/platform`, not the directory the command was
 * typed in. pnpm records that original directory in `INIT_CWD`; relative paths
 * resolve against it so `pnpm ops:backup-export --out exports` writes to
 * `./exports` where the operator (or a workflow step) expects it. Absolute
 * paths are returned unchanged.
 */
export function resolveUserPath(
  env: Readonly<Record<string, string | undefined>>,
  path: string,
): string {
  const base = env['INIT_CWD'];
  return resolve(base !== undefined && base.length > 0 ? base : process.cwd(), path);
}
