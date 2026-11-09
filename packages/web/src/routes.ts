import {
  Building2,
  LayoutDashboard,
  ScrollText,
  ShieldCheck,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { PermissionKey } from '@taxdesk/shared';

/** Signed-in pages. Paths are the public URLs; keep them stable once shipped. */
export const ROUTE_PATHS = {
  dashboard: '/',
  security: '/security',
  users: '/users',
  firmSettings: '/firm-settings',
  audit: '/audit',
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
  /** Hides the link without this permission. The API still enforces access. */
  readonly permission?: PermissionKey;
}

export const NAV_ROUTES: readonly NavRoute[] = [
  { path: ROUTE_PATHS.dashboard, label: 'Dashboard', title: 'Dashboard', icon: LayoutDashboard },
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
    path: ROUTE_PATHS.audit,
    label: 'Audit history',
    title: 'Audit history',
    icon: ScrollText,
    permission: 'audit.read',
  },
];
