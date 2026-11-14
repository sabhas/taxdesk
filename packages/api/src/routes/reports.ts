import { Hono, type Context } from 'hono';
import { type z } from 'zod';
import {
  BillingReportExportQuerySchema,
  BillingReportQuerySchema,
  BillingReportSchema,
  CaseReportExportQuerySchema,
  CaseReportQuerySchema,
  CaseReportSchema,
  DashboardSummarySchema,
  WorkloadReportQuerySchema,
  WorkloadReportSchema,
} from '@taxdesk/shared';
import type { AppEnv } from '../types.js';
import { AuthError } from '../domain/auth/errors.js';
import type { CsvExport } from '../domain/reports/report-service.js';
import { protect } from '../middleware/auth.js';

export const reportRoutes = new Hono<AppEnv>();

export function parseQuery<T>(c: Context<AppEnv>, schema: z.ZodType<T, z.ZodTypeDef, unknown>): T {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) {
    throw new AuthError(400, 'VALIDATION_FAILED', 'Check the filters.', {
      errors: parsed.error.issues.map((issue) => ({
        field: issue.path.length === 0 ? 'query' : issue.path.map(String).join('.'),
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}

function csvResponse(c: Context<AppEnv>, exported: CsvExport): Response {
  c.header('Content-Type', 'text/csv; charset=utf-8');
  c.header('Content-Disposition', `attachment; filename="${exported.fileName}"`);
  c.header('Cache-Control', 'no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Report-Rows', String(exported.rows));
  c.header('X-Report-Truncated', exported.truncated ? 'true' : 'false');
  return c.body(exported.csv);
}

const dashboard = () => protect({ access: 'permission', permission: 'dashboard.read' });
const reports = () => protect({ access: 'permission', permission: 'reports.read' });

reportRoutes.get('/dashboard/summary', dashboard(), async (c) => {
  const summary = await c.get('dependencies').reportService.dashboard(c.get('actor'));
  c.header('Cache-Control', 'no-store');
  return c.json(DashboardSummarySchema.parse(summary));
});

reportRoutes.get('/reports/cases', reports(), async (c) => {
  const query = parseQuery(c, CaseReportQuerySchema);
  const report = await c.get('dependencies').reportService.caseReport(c.get('actor'), query);
  c.header('Cache-Control', 'no-store');
  return c.json(CaseReportSchema.parse(report));
});

reportRoutes.get('/reports/cases.csv', reports(), async (c) => {
  const query = parseQuery(c, CaseReportExportQuerySchema);
  return csvResponse(
    c,
    await c
      .get('dependencies')
      .reportService.exportCaseReport(c.get('actor'), query, c.get('requestId')),
  );
});

reportRoutes.get('/reports/workload', reports(), async (c) => {
  const query = parseQuery(c, WorkloadReportQuerySchema);
  const report = await c.get('dependencies').reportService.workloadReport(c.get('actor'), query);
  c.header('Cache-Control', 'no-store');
  return c.json(WorkloadReportSchema.parse(report));
});

reportRoutes.get('/reports/billing', reports(), async (c) => {
  const query = parseQuery(c, BillingReportQuerySchema);
  const report = await c.get('dependencies').reportService.billingReport(c.get('actor'), query);
  c.header('Cache-Control', 'no-store');
  return c.json(BillingReportSchema.parse(report));
});

reportRoutes.get('/reports/billing.csv', reports(), async (c) => {
  const query = parseQuery(c, BillingReportExportQuerySchema);
  return csvResponse(
    c,
    await c
      .get('dependencies')
      .reportService.exportBillingReport(c.get('actor'), query, c.get('requestId')),
  );
});
