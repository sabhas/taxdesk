import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface SecretFinding {
  readonly path: string;
  readonly line: number;
  readonly ruleId: string;
}

export interface SecretScanResult {
  readonly check: 'secret-scan';
  readonly ok: boolean;
  readonly scannedFiles: number;
  readonly findings: readonly SecretFinding[];
}

interface SecretRule {
  readonly id: string;
  readonly pattern: RegExp;
  /** When set, the captured value may be a documented placeholder. */
  readonly allowPlaceholder?: boolean;
}

/**
 * High-confidence patterns that appear in real credentials. The scanner never
 * stores or prints the matched text: CI logs must not become a secret leak.
 */
const SECRET_RULES: readonly SecretRule[] = [
  {
    id: 'PRIVATE_KEY_BLOCK',
    pattern: /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/,
  },
  {
    id: 'AWS_ACCESS_KEY_ID',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  },
  {
    id: 'GITHUB_TOKEN',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  },
  {
    id: 'SLACK_TOKEN',
    pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/,
  },
  {
    id: 'GOOGLE_API_KEY',
    pattern: /AIza[0-9A-Za-z_-]{35}/,
  },
  {
    id: 'JWT',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  },
  {
    id: 'GENERIC_SECRET_ASSIGNMENT',
    pattern:
      /(?:api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|secret[_-]?key|password)\s*[:=]\s*["']([A-Za-z0-9_\-/+.]{16,})["']/i,
    allowPlaceholder: true,
  },
];

const FORBIDDEN_FILE_PATTERNS: readonly { id: string; pattern: RegExp }[] = [
  { id: 'ENV_FILE', pattern: /(^|\/)\.env(?!\.example$)(?:\.[^/]*)?$/ },
  { id: 'DEV_VARS_FILE', pattern: /(^|\/)\.dev\.vars(?:\.[^/]*)?$/ },
  { id: 'PRIVATE_KEY_FILE', pattern: /\.(?:pem|key|p12|pfx|jks|keystore)$/i },
  { id: 'SSH_PRIVATE_KEY_FILE', pattern: /(^|\/)id_(?:rsa|dsa|ecdsa|ed25519)$/ },
  { id: 'WRANGLER_STATE', pattern: /(^|\/)\.wrangler\// },
];

const SKIPPED_PREFIXES = [
  'node_modules/',
  '.git/',
  'dist/',
  'coverage/',
  '.pnpm-store/',
  '.pi-sandbox/',
];

const SKIPPED_FILE_NAMES = new Set(['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock']);

const MAX_FILE_BYTES = 512 * 1024;

function isPlaceholder(value: string): boolean {
  return (
    /^(?:REPLACE|CHANGE|EXAMPLE|PLACEHOLDER|DUMMY|FAKE|TEST|SAMPLE|YOUR|X{8,}|<)/i.test(value) ||
    /(?:REPLACE|CHANGE|EXAMPLE|PLACEHOLDER|DUMMY|FAKE|TEST|SAMPLE|SECRET|TOKEN|PASSWORD|VALUE)/i.test(
      value,
    )
  );
}

function forbiddenFileRule(path: string): string | undefined {
  if (path.endsWith('.example') || path.endsWith('.example.json')) {
    return undefined;
  }
  return FORBIDDEN_FILE_PATTERNS.find((rule) => rule.pattern.test(path))?.id;
}

function lineNumberAt(text: string, index: number): number {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (text.charCodeAt(cursor) === 10) {
      line += 1;
    }
  }
  return line;
}

/**
 * Scans one text file for high-confidence secret material. Findings contain
 * only the rule ID, path, and line number.
 */
export function scanText(path: string, text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const rule of SECRET_RULES) {
    const expression = new RegExp(
      rule.pattern.source,
      rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`,
    );
    for (const match of text.matchAll(expression)) {
      if (rule.allowPlaceholder === true) {
        const captured = match[1];
        if (captured === undefined || isPlaceholder(captured)) {
          continue;
        }
      }
      findings.push({
        path,
        line: lineNumberAt(text, match.index),
        ruleId: rule.id,
      });
    }
  }
  return findings;
}

function shouldSkipFile(path: string): boolean {
  if (SKIPPED_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return true;
  }
  const fileName = path.split('/').at(-1) ?? path;
  return SKIPPED_FILE_NAMES.has(fileName);
}

async function readScannableText(root: string, relativePath: string): Promise<string | undefined> {
  const absolutePath = join(root, relativePath);
  const fileStat = await stat(absolutePath);
  if (!fileStat.isFile() || fileStat.size > MAX_FILE_BYTES) {
    return undefined;
  }
  const contents = await readFile(absolutePath);
  // A NUL byte in the leading block reliably identifies a binary file.
  if (contents.subarray(0, 8192).includes(0)) {
    return undefined;
  }
  return contents.toString('utf8');
}

/**
 * Scans a fixed list of repo-relative files. Tests use this entry point; the
 * CLI resolves the tracked file list with `git ls-files` and calls it.
 */
export async function scanFiles(root: string, files: readonly string[]): Promise<SecretScanResult> {
  const findings: SecretFinding[] = [];
  let scannedFiles = 0;

  for (const relativePath of [...files].sort()) {
    if (shouldSkipFile(relativePath)) {
      continue;
    }
    const forbiddenRule = forbiddenFileRule(relativePath);
    if (forbiddenRule !== undefined) {
      findings.push({ path: relativePath, line: 1, ruleId: forbiddenRule });
      continue;
    }
    const text = await readScannableText(root, relativePath);
    if (text === undefined) {
      continue;
    }
    scannedFiles += 1;
    findings.push(...scanText(relativePath, text));
  }

  const unique = [
    ...new Map(
      findings.map((finding) => [
        `${finding.path}:${String(finding.line)}:${finding.ruleId}`,
        finding,
      ]),
    ).values(),
  ].sort((left, right) =>
    left.path === right.path
      ? left.line === right.line
        ? left.ruleId.localeCompare(right.ruleId)
        : left.line - right.line
      : left.path.localeCompare(right.path),
  );

  return {
    check: 'secret-scan',
    ok: unique.length === 0,
    scannedFiles,
    findings: unique,
  };
}

/** Resolves tracked files. Untracked local files are covered by .gitignore, not CI. */
export async function listTrackedFiles(root: string): Promise<string[]> {
  const { stdout } = await execFileAsync('git', ['ls-files', '-z'], {
    cwd: root,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.split('\0').filter((entry) => entry.length > 0);
}

/** Scans every tracked file in a repository checkout. */
export async function scanRepository(
  root: string,
  options: { readonly files?: readonly string[] } = {},
): Promise<SecretScanResult> {
  const files = options.files ?? (await listTrackedFiles(root));
  return scanFiles(root, files);
}
