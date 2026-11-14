import {
  AuditExplorerListSchema,
  BillingReportSchema,
  CaseReportSchema,
  DashboardSummarySchema,
  WorkloadReportSchema,
  type AuditExplorerList,
  type BillingReport,
  type CaseReport,
  type DashboardSummary,
  type WorkloadReport,
} from '@taxdesk/shared';
import { apiRequest } from './api-client.js';

/**
 * Dashboard, report, and audit-explorer clients (Epic 6). The API scopes every
 * result from the signed-in user's permissions; filters here only narrow it.
 */

export interface CaseReportFilters {
  readonly from?: string;
  readonly to?: string;
  readonly service?: string;
  readonly status?: string;
  readonly statusKind?: string;
  readonly assignee?: string;
  readonly taxYear?: string;
  readonly state?: string;
}

export interface WorkloadFilters {
  readonly from?: string;
  readonly to?: string;
  readonly service?: string;
  readonly taxYear?: string;
}

export interface BillingReportFilters {
  readonly from: string;
  readonly to: string;
  readonly client?: string;
}

export interface AuditFilters {
  readonly actor?: string;
  readonly from?: string;
  readonly to?: string;
  readonly action?: string;
  readonly entityType?: string;
  readonly entityId?: string;
  readonly requestId?: string;
}

function query(values: Readonly<Record<string, string | number | undefined>>): string {
  const parameters = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined && value !== '') {
      parameters.set(name, String(value));
    }
  }
  return parameters.toString();
}

function read(signal: AbortSignal | undefined) {
  return { sessionScoped: true, ...(signal === undefined ? {} : { signal }) } as const;
}

export async function getDashboardSummary(signal?: AbortSignal): Promise<DashboardSummary> {
  return await apiRequest('/api/v1/dashboard/summary', DashboardSummarySchema, read(signal));
}

export async function getCaseReport(
  filters: CaseReportFilters & { limit?: number; cursor?: string | null },
  signal?: AbortSignal,
): Promise<CaseReport> {
  const { cursor, ...rest } = filters;
  return await apiRequest(
    `/api/v1/reports/cases?${query({ ...rest, cursor: cursor ?? undefined })}`,
    CaseReportSchema,
    read(signal),
  );
}

export async function getWorkloadReport(
  filters: WorkloadFilters,
  signal?: AbortSignal,
): Promise<WorkloadReport> {
  return await apiRequest(
    `/api/v1/reports/workload?${query({ ...filters })}`,
    WorkloadReportSchema,
    read(signal),
  );
}

export async function getBillingReport(
  filters: BillingReportFilters & { limit?: number; cursor?: string | null },
  signal?: AbortSignal,
): Promise<BillingReport> {
  const { cursor, ...rest } = filters;
  return await apiRequest(
    `/api/v1/reports/billing?${query({ ...rest, cursor: cursor ?? undefined })}`,
    BillingReportSchema,
    read(signal),
  );
}

/** Same-origin CSV download links; the API rechecks the permission and audits each export. */
export function caseReportCsvUrl(filters: CaseReportFilters): string {
  return `/api/v1/reports/cases.csv?${query({ ...filters })}`;
}

export function billingReportCsvUrl(filters: BillingReportFilters): string {
  return `/api/v1/reports/billing.csv?${query({ ...filters })}`;
}

export async function listAuditEvents(
  input: AuditFilters & { limit?: number; cursor?: string | null } = {},
  signal?: AbortSignal,
): Promise<AuditExplorerList> {
  const { cursor, limit, ...filters } = input;
  return await apiRequest(
    `/api/v1/admin/audit-events?${query({ ...filters, limit: limit ?? 25, cursor: cursor ?? undefined })}`,
    AuditExplorerListSchema,
    read(signal),
  );
}
