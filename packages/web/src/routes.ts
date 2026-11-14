import {
  BookUser,
  Briefcase,
  Building2,
  HardDrive,
  Receipt,
  ChartColumn,
  FileUp,
  ListChecks,
  Tags,
  LayoutDashboard,
  ScrollText,
  ShieldCheck,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { STORAGE_CALLBACK_PATH, STORAGE_SETTINGS_PATH, type PermissionKey } from '@taxdesk/shared';

/** Signed-in pages. Paths are the public URLs; keep them stable once shipped. */
export const ROUTE_PATHS = {
  dashboard: '/',
  security: '/security',
  users: '/users',
  firmSettings: '/firm-settings',
  audit: '/audit',
  clients: '/clients',
  newClient: '/clients/new',
  cases: '/cases',
  newCase: '/cases/new',
  invoices: '/invoices',
  reports: '/reports',
  reportsWorkload: '/reports/workload',
  reportsBilling: '/reports/billing',
  services: '/services',
  workflows: '/workflows',
  imports: '/imports',
  /** The storage OAuth callback redirects here (`?result=`). */
  storage: STORAGE_SETTINGS_PATH,
  /** The storage provider redirects the browser here after consent. */
  storageCallback: STORAGE_CALLBACK_PATH,
  /** Built by the API (`activationUrl`) as `/activate?token=…`. */
  activate: '/activate',
} as const;

export interface NavRoute {
  readonly path: string;
  /** Link text in the navigation. */
  readonly label: string;
  /** `document.title` prefix, shown as "<title> · TaxDesk". */
  readonly title: string;
  readonly icon: LucideIcon;
  /**
   * Hides the link unless the user holds this permission (or, for a list, any
   * of them). The API still enforces access.
   */
  readonly permission?: PermissionKey | readonly PermissionKey[];
  /** `false` keeps the link active on nested pages (e.g. a client record). */
  readonly end?: boolean;
}

export function clientPath(clientId: string): string {
  return `${ROUTE_PATHS.clients}/${encodeURIComponent(clientId)}`;
}

export function editClientPath(clientId: string): string {
  return `${clientPath(clientId)}/edit`;
}

export function casePath(caseId: string): string {
  return `${ROUTE_PATHS.cases}/${encodeURIComponent(caseId)}`;
}

export function newCasePath(clientId?: string): string {
  return clientId === undefined
    ? ROUTE_PATHS.newCase
    : `${ROUTE_PATHS.newCase}?client=${encodeURIComponent(clientId)}`;
}

export function invoicePath(invoiceId: string): string {
  return `${ROUTE_PATHS.invoices}/${encodeURIComponent(invoiceId)}`;
}

export function importBatchPath(batchId: string): string {
  return `${ROUTE_PATHS.imports}/${encodeURIComponent(batchId)}`;
}

export function workflowPath(templateId: string): string {
  return `${ROUTE_PATHS.workflows}/${encodeURIComponent(templateId)}`;
}

/** UI gating only: whether the navigation shows a route to this user. */
export function canSeeRoute(route: NavRoute, can: (permission: PermissionKey) => boolean): boolean {
  const required = route.permission;
  if (required === undefined) {
    return true;
  }
  return typeof required === 'string' ? can(required) : required.some((key) => can(key));
}

/** Case work is visible with either case-read permission. */
export const CASE_READ_PERMISSIONS: readonly PermissionKey[] = [
  'cases.read_all',
  'cases.read_assigned',
];

export const NAV_ROUTES: readonly NavRoute[] = [
  { path: ROUTE_PATHS.dashboard, label: 'Dashboard', title: 'Dashboard', icon: LayoutDashboard },
  {
    path: ROUTE_PATHS.clients,
    label: 'Clients',
    title: 'Clients',
    icon: BookUser,
    permission: 'clients.read',
    end: false,
  },
  {
    path: ROUTE_PATHS.cases,
    label: 'Cases',
    title: 'Cases',
    icon: Briefcase,
    permission: CASE_READ_PERMISSIONS,
    end: false,
  },
  {
    path: ROUTE_PATHS.invoices,
    label: 'Invoices',
    title: 'Invoices',
    icon: Receipt,
    permission: 'billing.read',
    end: false,
  },
  {
    path: ROUTE_PATHS.reports,
    label: 'Reports',
    title: 'Reports',
    icon: ChartColumn,
    permission: 'reports.read',
    end: false,
  },
  {
    path: ROUTE_PATHS.services,
    label: 'Services',
    title: 'Services',
    icon: Tags,
    permission: 'services.manage',
  },
  {
    path: ROUTE_PATHS.workflows,
    label: 'Workflows',
    title: 'Workflows',
    icon: ListChecks,
    permission: 'services.manage',
    end: false,
  },
  { path: ROUTE_PATHS.security, label: 'Security', title: 'Security', icon: ShieldCheck },
  {
    path: ROUTE_PATHS.users,
    label: 'Users',
    title: 'Users',
    icon: Users,
    permission: 'users.manage',
  },
  {
    path: ROUTE_PATHS.firmSettings,
    label: 'Firm settings',
    title: 'Firm settings',
    icon: Building2,
    permission: 'firm.settings.read',
  },
  {
    path: ROUTE_PATHS.storage,
    label: 'Document storage',
    title: 'Document storage',
    icon: HardDrive,
    permission: 'storage.manage',
  },
  {
    path: ROUTE_PATHS.imports,
    label: 'Data import',
    title: 'Data import',
    icon: FileUp,
    permission: 'imports.manage',
    end: false,
  },
  {
    path: ROUTE_PATHS.audit,
    label: 'Audit history',
    title: 'Audit history',
    icon: ScrollText,
    permission: 'audit.read',
  },
];
