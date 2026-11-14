import { importTemplate, type ImportTemplateId } from '@taxdesk/shared';

/**
 * Sanitized, production-shaped import files for the migration rehearsal
 * (TD-706). Every value is generated: identifiers use the impossible `00000`
 * CNIC region and a `0` NTN prefix, emails use `example.test`, and names come
 * from a fixed synthetic word list. Output is deterministic for a seed, so a
 * rehearsal can be repeated and its reconciliation compared run to run.
 */

export interface SampleImportOptions {
  readonly clients: number;
  readonly casesPerClient: number;
  readonly balanceShare: number;
  readonly seed: number;
  readonly service: string;
  readonly taxYear: number;
  readonly asOfDate: string;
  /** Adds rows that must be caught: a bad email, an in-file duplicate, a possible duplicate. */
  readonly withExceptions: boolean;
}

export interface SampleImportFiles {
  readonly files: Readonly<Record<ImportTemplateId, string>>;
  /** The "source system" totals the rehearsal reconciles against. */
  readonly sourceTotals: {
    readonly clients: number;
    readonly activeCases: number;
    readonly openingBalances: number;
    readonly openingBalanceMinor: number;
    readonly exceptionRows: number;
  };
}

const FIRST = [
  'Amber',
  'Basil',
  'Cedar',
  'Dune',
  'Ember',
  'Fern',
  'Garnet',
  'Hazel',
  'Iris',
  'Juniper',
];
const LAST = [
  'Stone',
  'River',
  'Field',
  'Brook',
  'Vale',
  'Ridge',
  'Grove',
  'Marsh',
  'Cliff',
  'Shore',
];
const TRADE = [
  'Traders',
  'Textiles',
  'Logistics',
  'Foods',
  'Builders',
  'Studio',
  'Exports',
  'Motors',
];

/** mulberry32: small deterministic PRNG for reproducible fixtures. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function quote(cell: string): string {
  return /[",\r\n]/u.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
}

function toCsv(template: ImportTemplateId, rows: readonly (readonly string[])[]): string {
  const header = importTemplate(template).columns.map((column) => column.name);
  return `${[header, ...rows].map((cells) => cells.map(quote).join(',')).join('\r\n')}\r\n`;
}

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)] as T;
}

function amount(minor: number): string {
  return `${String(Math.floor(minor / 100))}.${String(minor % 100).padStart(2, '0')}`;
}

export function generateSampleImport(options: SampleImportOptions): SampleImportFiles {
  const random = prng(options.seed);
  const clientRows: string[][] = [];
  const caseRows: string[][] = [];
  const balanceRows: string[][] = [];
  let balanceMinor = 0;
  for (let index = 1; index <= options.clients; index += 1) {
    const ref = `SYN-C-${String(index).padStart(6, '0')}`;
    const serial = String(index).padStart(7, '0');
    const business = random() < 0.3;
    const name = business
      ? `${pick(random, LAST)} ${pick(random, TRADE)} ${String(index)} (Pvt.) Ltd.`
      : `${pick(random, FIRST)} ${pick(random, LAST)} ${String(index)}`;
    const email = random() < 0.7 ? `client${String(index)}@example.test` : '';
    const phone = email === '' ? `0300 ${serial}` : '';
    clientRows.push([
      ref,
      business ? 'business' : 'individual',
      name,
      '',
      business ? '' : `00000-${serial}-1`,
      business ? `0${serial.slice(1)}-1` : '',
      name,
      business ? 'director' : 'self',
      email,
      phone,
      '',
      '',
    ]);
    if (random() < options.casesPerClient) {
      caseRows.push([
        `SYN-T-${String(index).padStart(6, '0')}`,
        ref,
        options.service,
        String(options.taxYear),
        '',
        '',
        '',
        '',
        '',
      ]);
    }
    if (random() < options.balanceShare) {
      const minor = (Math.floor(random() * 500) + 10) * 1_000 + Math.floor(random() * 100);
      balanceMinor += minor;
      balanceRows.push([
        `SYN-B-${String(index).padStart(6, '0')}`,
        ref,
        '',
        options.asOfDate,
        '',
        amount(minor),
        '',
      ]);
    }
  }
  let exceptionRows = 0;
  if (options.withExceptions && options.clients >= 2) {
    const first = clientRows[0] ?? [];
    // An invalid email, an in-file CNIC duplicate, and a same-name possible duplicate.
    clientRows.push([
      'SYN-X-000001',
      'individual',
      'Exception Bad Email',
      '',
      '00000-9999991-1',
      '',
      'Exception Bad Email',
      'self',
      'not-an-email',
      '',
      '',
      '',
    ]);
    clientRows.push([
      'SYN-X-000002',
      'individual',
      'Exception Duplicate Id',
      '',
      '00000-9999991-1',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
    ]);
    clientRows.push([
      'SYN-X-000003',
      'individual',
      first[2] ?? 'Exception Name',
      '',
      '00000-9999993-1',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
    ]);
    exceptionRows = 3;
  }
  return {
    files: {
      'clients.v1': toCsv('clients.v1', clientRows),
      'cases.v1': toCsv('cases.v1', caseRows),
      'opening_balances.v1': toCsv('opening_balances.v1', balanceRows),
    },
    sourceTotals: {
      clients: options.clients,
      activeCases: caseRows.length,
      openingBalances: balanceRows.length,
      openingBalanceMinor: balanceMinor,
      exceptionRows,
    },
  };
}
