import {
  AUDIT_ACTIONS,
  DEFAULT_FIRM_SETTINGS,
  REPORT_LIMITS,
  calendarDateIn,
  monthBounds,
  type BillingReport,
  type BillingReportExportQuery,
  type BillingReportQuery,
  type CaseListItem,
  type CaseReport,
  type CaseReportExportQuery,
  type CaseReportQuery,
  type DashboardCount,
  type DashboardSummary,
  type InvoiceSummary,
  type WorkloadReport,
  type WorkloadReportQuery,
  type WorkloadRow,
} from '@taxdesk/shared';
import type { CaseQueryFilter } from '../cases/types.js';
import type { Repositories, UnitOfWork } from '../../repositories/ports.js';
import { appendAuditEvent } from '../auth/audit-service.js';
import { hasPermission } from '../auth/authorization.js';
import { forbidden } from '../auth/errors.js';
import type { Actor } from '../auth/types.js';
import { readsAllCases } from '../cases/case-access.js';
import type { CaseService } from '../cases/case-service.js';
import { readsAllInvoices } from '../billing/billing-access.js';
import type { BillingService } from '../billing/billing-service.js';
import { buildCsv, formatMinorAsDecimal } from './csv.js';

export interface ReportServiceDependencies {
  readonly repositories: Repositories;
  readonly unitOfWork: UnitOfWork;
  readonly caseService: CaseService;
  readonly billingService: BillingService;
  readonly clock: () => Date;
}

export interface CsvExport {
  readonly fileName: string;
  readonly csv: string;
  readonly rows: number;
  /** `true` when the export stopped at the row limit. */
  readonly truncated: boolean;
}

function href(path: string, params: Record<string, string | undefined> = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      search.set(key, value);
    }
  }
  const query = search.toString();
  return query.length === 0 ? path : `${path}?${query}`;
}

function canReadCases(actor: Actor): boolean {
  return hasPermission(actor, 'cases.read_all') || hasPermission(actor, 'cases.read_assigned');
}

/** Billing figures need the billing permission and every client's invoices. */
function canReadBillingFigures(actor: Actor): boolean {
  return hasPermission(actor, 'billing.read') && readsAllInvoices(actor);
}

/**
 * Dashboard and report queries (Epic 6). Every figure is computed with the
 * same filter builder and repository predicate as the list it links to, and
 * every query is scoped from the signed-in user's permissions, never from the
 * request.
 */
export class ReportService {
  constructor(private readonly dependencies: ReportServiceDependencies) {}

  private get repositories(): Repositories {
    return this.dependencies.repositories;
  }

  private async firmContext(): Promise<{
    timezone: string;
    today: string;
    dueSoonDays: number;
  }> {
    const firm = await this.repositories.firm.get();
    const timezone = firm?.timezone ?? 'Asia/Karachi';
    return {
      timezone,
      today: calendarDateIn(timezone, this.dependencies.clock()),
      dueSoonDays: firm?.dueSoonDays ?? DEFAULT_FIRM_SETTINGS.dueSoonDays,
    };
  }

  // -------------------------------------------------------------------------
  // Dashboard (TD-601)
  // -------------------------------------------------------------------------

  private async caseCount(
    actor: Actor,
    view: CaseQueryFilter['view'],
    params: Record<string, string>,
    query: Parameters<CaseService['filterFor']>[2],
    overrides: Partial<CaseQueryFilter> = {},
  ): Promise<DashboardCount> {
    const filter = await this.dependencies.caseService.filterFor(actor, view, query, overrides);
    return {
      count: await this.repositories.cases.count(filter),
      href: href('/cases', {
        view: view === 'any' || view === 'active' ? undefined : view,
        ...params,
      }),
    };
  }

  async dashboard(actor: Actor): Promise<DashboardSummary> {
    const context = await this.firmContext();
    const mayReadCases = canReadCases(actor);
    const month = monthBounds(context.today);

    let work: DashboardSummary['work'] = null;
    if (mayReadCases) {
      work = {
        assigned: await this.caseCount(actor, 'my', {}, {}),
        overdue: await this.caseCount(actor, 'overdue', {}, {}),
        dueSoon: await this.caseCount(actor, 'due_soon', {}, {}),
        checklistGaps: await this.caseCount(
          actor,
          'my',
          { checklist: 'gaps' },
          { checklist: 'gaps' },
        ),
        filing: {
          inProgress: await this.caseCount(
            actor,
            'team',
            { statusKind: 'open' },
            { statusKind: 'open' },
          ),
          filed: await this.caseCount(
            actor,
            'team',
            { statusKind: 'filed' },
            { statusKind: 'filed' },
          ),
          completed: await this.caseCount(
            actor,
            'closed',
            { statusKind: 'completed' },
            { statusKind: 'completed' },
          ),
        },
      };
    }

    let management: DashboardSummary['management'] = null;
    const manages = hasPermission(actor, 'cases.assign') || hasPermission(actor, 'cases.manage');
    if (mayReadCases && manages && readsAllCases(actor)) {
      const assignees = await this.dependencies.caseService.listAssignees();
      const workload: WorkloadRow[] = [];
      for (const person of assignees) {
        workload.push(await this.workloadRow(actor, person.id, person.displayName, {}));
      }
      management = {
        unassigned: await this.caseCount(actor, 'unassigned', {}, {}),
        teamOpen: await this.caseCount(actor, 'team', {}, {}),
        teamOverdue: await this.caseCount(actor, 'overdue', {}, {}),
        reviewQueue: await this.caseCount(
          actor,
          'team',
          { checklist: 'awaiting_review' },
          { checklist: 'awaiting_review' },
        ),
        workload,
      };
    }

    let billing: DashboardSummary['billing'] = null;
    if (canReadBillingFigures(actor)) {
      const scope = { clientId: null, visibleClientIds: null } as const;
      const totals = await this.repositories.billingReports.invoiceTotals({
        issuedFrom: null,
        issuedTo: null,
        today: context.today,
        ...scope,
      });
      const collection = await this.repositories.billingReports.collectionTotals({
        from: month.start,
        to: month.end,
        timezone: context.timezone,
        ...scope,
      });
      billing = {
        unpaid: {
          ...totals.outstanding,
          href: href('/invoices', { balance: 'outstanding' }),
        },
        overdue: { ...totals.overdue, href: href('/invoices', { balance: 'overdue' }) },
        monthStart: month.start,
        monthEnd: month.end,
        collected: {
          receivedMinor: collection.collected.amountMinor,
          reversedMinor: collection.reversed.amountMinor,
          netMinor: collection.collected.amountMinor - collection.reversed.amountMinor,
          href: href('/reports/billing', { from: month.start, to: month.end }),
        },
      };
    }

    return {
      generatedAt: this.dependencies.clock().toISOString(),
      today: context.today,
      dueSoonDays: context.dueSoonDays,
      work,
      management,
      billing,
    };
  }

  // -------------------------------------------------------------------------
  // Case and workload reports (TD-602)
  // -------------------------------------------------------------------------

  private requireCaseReport(actor: Actor): void {
    if (!hasPermission(actor, 'reports.read') || !canReadCases(actor)) {
      throw forbidden('You do not have permission to view case reports.');
    }
  }

  private reportFilter(actor: Actor, query: CaseReportExportQuery): Promise<CaseQueryFilter> {
    const view = query.state === 'archived' ? 'archived' : query.state === 'all' ? 'any' : 'active';
    return this.dependencies.caseService.filterFor(
      actor,
      view,
      {
        ...(query.service === undefined ? {} : { service: query.service }),
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.assignee === undefined ? {} : { assignee: query.assignee }),
        ...(query.taxYear === undefined ? {} : { taxYear: query.taxYear }),
      },
      {
        statusKind: query.statusKind ?? null,
        dueFrom: query.from ?? null,
        dueTo: query.to ?? null,
      },
    );
  }

  async caseReport(actor: Actor, query: CaseReportQuery): Promise<CaseReport> {
    this.requireCaseReport(actor);
    const list = await this.dependencies.caseService.listForFilter(
      await this.reportFilter(actor, query),
      query.limit,
      query.cursor,
    );
    return list;
  }

  async exportCaseReport(
    actor: Actor,
    query: CaseReportExportQuery,
    requestId: string,
  ): Promise<CsvExport> {
    this.requireCaseReport(actor);
    const filter = await this.reportFilter(actor, query);
    const rows: CaseListItem[] = [];
    let cursor: string | undefined;
    let truncated = false;
    for (;;) {
      const page = await this.dependencies.caseService.listForFilter(filter, 100, cursor);
      for (const item of page.cases) {
        if (rows.length >= REPORT_LIMITS.csvMaxRows) {
          truncated = true;
          break;
        }
        rows.push(item);
      }
      if (truncated || page.nextCursor === null) {
        break;
      }
      cursor = page.nextCursor;
    }
    const csv = buildCsv(
      [
        'Case code',
        'Client code',
        'Client',
        'Service',
        'Tax year',
        'Status',
        'Due date',
        'Urgency',
        'Primary consultant',
        'Reviewer',
        'State',
      ],
      rows.map((item) => [
        item.caseCode,
        item.client.clientCode,
        item.client.displayName,
        item.serviceName,
        item.taxYear,
        item.status.name,
        item.dueDate,
        item.urgency ?? '',
        item.primaryConsultant?.displayName ?? '',
        item.reviewer?.displayName ?? '',
        item.state,
      ]),
    );
    await this.auditExport(actor, 'cases', rows.length, truncated, requestId, {
      state: query.state,
      from: query.from ?? '',
      to: query.to ?? '',
    });
    return { fileName: 'cases-report.csv', csv, rows: rows.length, truncated };
  }

  private async workloadRow(
    actor: Actor,
    userId: string,
    displayName: string,
    query: Pick<WorkloadReportQuery, 'service' | 'taxYear'>,
    range: { from?: string; to?: string } = {},
  ): Promise<WorkloadRow> {
    const base = {
      ...(query.service === undefined ? {} : { service: query.service }),
      ...(query.taxYear === undefined ? {} : { taxYear: query.taxYear }),
    };
    const links = {
      ...(query.service === undefined ? {} : { service: query.service }),
      ...(query.taxYear === undefined ? {} : { taxYear: String(query.taxYear) }),
    };
    const dates = {
      dueFrom: range.from ?? null,
      dueTo: range.to ?? null,
    };
    const count = async (
      view: CaseQueryFilter['view'],
      who: 'assignee' | 'reviewer',
    ): Promise<DashboardCount> => {
      const filter = await this.dependencies.caseService.filterFor(
        actor,
        view,
        { ...base, [who]: userId },
        dates,
      );
      return {
        count: await this.repositories.cases.count(filter),
        href: href('/cases', { view, [who]: userId, ...links }),
      };
    };
    return {
      userId,
      displayName,
      open: await count('team', 'assignee'),
      overdue: await count('overdue', 'assignee'),
      dueSoon: await count('due_soon', 'assignee'),
      reviewing: await count('team', 'reviewer'),
    };
  }

  async workloadReport(actor: Actor, query: WorkloadReportQuery): Promise<WorkloadReport> {
    this.requireCaseReport(actor);
    const context = await this.firmContext();
    const assignees = await this.dependencies.caseService.listAssignees();
    const rows: WorkloadRow[] = [];
    for (const person of assignees) {
      rows.push(
        await this.workloadRow(actor, person.id, person.displayName, query, {
          ...(query.from === undefined ? {} : { from: query.from }),
          ...(query.to === undefined ? {} : { to: query.to }),
        }),
      );
    }
    return { today: context.today, dueSoonDays: context.dueSoonDays, rows };
  }

  // -------------------------------------------------------------------------
  // Billing report (TD-603)
  // -------------------------------------------------------------------------

  private requireBillingReport(actor: Actor): void {
    if (!hasPermission(actor, 'reports.read') || !canReadBillingFigures(actor)) {
      throw forbidden('You do not have permission to view billing reports.');
    }
  }

  async billingReport(actor: Actor, query: BillingReportQuery): Promise<BillingReport> {
    this.requireBillingReport(actor);
    const context = await this.firmContext();
    const scope = { clientId: query.client ?? null, visibleClientIds: null } as const;
    const invoiceTotals = await this.repositories.billingReports.invoiceTotals({
      issuedFrom: query.from,
      issuedTo: query.to,
      today: context.today,
      ...scope,
    });
    const collection = await this.repositories.billingReports.collectionTotals({
      from: query.from,
      to: query.to,
      timezone: context.timezone,
      ...scope,
    });
    // The rows come from the same invoice list (and balances) as invoice detail.
    const list = await this.dependencies.billingService.listInvoices(actor, {
      status: 'finalized',
      issuedFrom: query.from,
      issuedTo: query.to,
      ...(query.client === undefined ? {} : { clientId: query.client }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      limit: query.limit,
    });
    const firm = await this.repositories.firm.get();
    return {
      from: query.from,
      to: query.to,
      today: context.today,
      currency: firm?.currency ?? DEFAULT_FIRM_SETTINGS.currency,
      totals: {
        invoiced: invoiceTotals.invoiced,
        collected: collection.collected,
        reversed: collection.reversed,
        netCollectedMinor: collection.collected.amountMinor - collection.reversed.amountMinor,
        outstanding: invoiceTotals.outstanding,
        overdue: invoiceTotals.overdue,
      },
      invoices: list.invoices,
      nextCursor: list.nextCursor,
    };
  }

  async exportBillingReport(
    actor: Actor,
    query: BillingReportExportQuery,
    requestId: string,
  ): Promise<CsvExport> {
    this.requireBillingReport(actor);
    const rows: InvoiceSummary[] = [];
    let cursor: string | undefined;
    let truncated = false;
    for (;;) {
      const page = await this.dependencies.billingService.listInvoices(actor, {
        status: 'finalized',
        issuedFrom: query.from,
        issuedTo: query.to,
        ...(query.client === undefined ? {} : { clientId: query.client }),
        ...(cursor === undefined ? {} : { cursor }),
        limit: 100,
      });
      for (const invoice of page.invoices) {
        if (rows.length >= REPORT_LIMITS.csvMaxRows) {
          truncated = true;
          break;
        }
        rows.push(invoice);
      }
      if (truncated || page.nextCursor === null) {
        break;
      }
      cursor = page.nextCursor;
    }
    const csv = buildCsv(
      [
        'Invoice number',
        'Client code',
        'Client',
        'Case',
        'Issue date',
        'Due date',
        'Total',
        'Paid',
        'Outstanding',
        'Payment status',
      ],
      rows.map((invoice) => [
        invoice.invoiceNumber,
        invoice.client.clientCode,
        invoice.client.displayName,
        invoice.case?.caseCode ?? '',
        invoice.issueDate,
        invoice.dueDate,
        formatMinorAsDecimal(invoice.totalMinor),
        formatMinorAsDecimal(invoice.paidMinor),
        formatMinorAsDecimal(invoice.outstandingMinor),
        invoice.paymentStatus,
      ]),
    );
    await this.auditExport(actor, 'billing', rows.length, truncated, requestId, {
      from: query.from,
      to: query.to,
    });
    return { fileName: 'billing-report.csv', csv, rows: rows.length, truncated };
  }

  private async auditExport(
    actor: Actor,
    kind: string,
    rows: number,
    truncated: boolean,
    requestId: string,
    filters: Record<string, string>,
  ): Promise<void> {
    const now = this.dependencies.clock();
    await this.dependencies.unitOfWork.run(async (repositories) => {
      await appendAuditEvent(repositories.audit, now, {
        actorUserId: actor.userId,
        action: AUDIT_ACTIONS.reportExported,
        entityType: 'report',
        entityId: null,
        requestId,
        metadata: { report: kind, rows, truncated, ...filters },
      });
    });
  }
}
