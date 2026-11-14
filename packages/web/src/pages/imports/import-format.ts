import type {
  ImportBatchStatus,
  ImportKind,
  ImportRowAction,
  ImportRowOutcome,
} from '@taxdesk/shared';

type BadgeVariant = 'default' | 'secondary' | 'success' | 'warning' | 'destructive' | 'outline';

export const KIND_LABELS: Readonly<Record<ImportKind, string>> = {
  clients: 'Clients',
  cases: 'Active cases',
  opening_balances: 'Opening balances',
};

export const STATUS_LABELS: Readonly<Record<ImportBatchStatus, string>> = {
  validated: 'Ready to commit',
  blocked: 'Needs attention',
  committing: 'Committing',
  committed: 'Committed',
  discarded: 'Discarded',
};

export const STATUS_BADGE: Readonly<Record<ImportBatchStatus, BadgeVariant>> = {
  validated: 'success',
  blocked: 'warning',
  committing: 'secondary',
  committed: 'default',
  discarded: 'outline',
};

export const ACTION_LABELS: Readonly<Record<ImportRowAction, string>> = {
  create: 'Create',
  update: 'Update',
  skip: 'Skip',
  review: 'Possible duplicate',
  error: 'Error',
};

export const ACTION_BADGE: Readonly<Record<ImportRowAction, BadgeVariant>> = {
  create: 'success',
  update: 'secondary',
  skip: 'outline',
  review: 'warning',
  error: 'destructive',
};

export const OUTCOME_LABELS: Readonly<Record<ImportRowOutcome, string>> = {
  created: 'Created',
  updated: 'Updated',
  skipped: 'Skipped',
  failed: 'Failed',
};

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Reads a chosen file as UTF-8 text. */
export async function readFileText(file: File): Promise<string> {
  // `File.text()` is missing in some test runtimes; FileReader is universal.
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(typeof reader.result === 'string' ? reader.result : '');
    };
    reader.onerror = () => {
      reject(new Error('The file could not be read.'));
    };
    reader.readAsText(file, 'utf-8');
  });
}
