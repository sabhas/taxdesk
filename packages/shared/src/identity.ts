import { z } from 'zod';

/**
 * Built-in roles. The role catalog is fixed for this epic: there is no custom
 * role editor and no request-supplied authorization scope. Every authorization
 * decision derives from the authenticated user's assigned roles.
 */
export const ROLE_KEYS = [
  'administrator',
  'manager',
  'consultant',
  'billing',
  'read_only',
] as const;

export const RoleKeySchema = z.enum(ROLE_KEYS);

export type RoleKey = z.infer<typeof RoleKeySchema>;

export interface RoleDefinition {
  readonly key: RoleKey;
  readonly name: string;
  readonly description: string;
  readonly permissions: readonly PermissionKey[];
}

/**
 * Permission keys group by capability area so later epics add routes with an
 * explicit, reviewable declaration. A permission may only be checked on the
 * server; the browser uses the same list to hide affordances.
 */
export const PERMISSION_KEYS = [
  'firm.settings.read',
  'firm.settings.manage',
  'users.read',
  'users.manage',
  'audit.read',
  'clients.read',
  'clients.manage',
  'cases.read_all',
  'cases.read_assigned',
  'cases.manage',
  'cases.work_assigned',
  'cases.assign',
  'documents.read',
  'documents.manage',
  'billing.read',
  'billing.manage',
  'reports.read',
  'dashboard.read',
] as const;

export const PermissionKeySchema = z.enum(PERMISSION_KEYS);

export type PermissionKey = z.infer<typeof PermissionKeySchema>;

const ALL_PERMISSIONS: readonly PermissionKey[] = PERMISSION_KEYS;

/**
 * The canonical role/permission matrix. The database seed, API guards, and web
 * navigation all consume these definitions; a migration test and shared unit
 * tests keep the SQL seed and this matrix in sync.
 */
export const ROLE_DEFINITIONS: Readonly<Record<RoleKey, RoleDefinition>> = {
  administrator: {
    key: 'administrator',
    name: 'Administrator',
    description: 'User, integration, setting, audit, and full-record control.',
    permissions: ALL_PERMISSIONS,
  },
  manager: {
    key: 'manager',
    name: 'Manager',
    description: 'All case and client visibility, assignments, review, and reports.',
    permissions: [
      'firm.settings.read',
      'clients.read',
      'clients.manage',
      'cases.read_all',
      'cases.manage',
      'cases.assign',
      'documents.read',
      'documents.manage',
      'billing.read',
      'reports.read',
      'dashboard.read',
    ],
  },
  consultant: {
    key: 'consultant',
    name: 'Consultant',
    description: 'Assigned case and client work, checklists, and documents.',
    permissions: [
      'firm.settings.read',
      'clients.read',
      'cases.read_assigned',
      'cases.work_assigned',
      'documents.read',
      'documents.manage',
      'dashboard.read',
    ],
  },
  billing: {
    key: 'billing',
    name: 'Billing',
    description: 'Invoices, payments, receipts, and billing reports.',
    permissions: [
      'firm.settings.read',
      'clients.read',
      'cases.read_all',
      'billing.read',
      'billing.manage',
      'reports.read',
      'dashboard.read',
    ],
  },
  read_only: {
    key: 'read_only',
    name: 'Read-only',
    description: 'Explicitly permitted records without mutation.',
    permissions: [
      'firm.settings.read',
      'clients.read',
      'cases.read_all',
      'documents.read',
      'billing.read',
      'reports.read',
      'dashboard.read',
    ],
  },
};

export const BUILT_IN_ROLES: readonly RoleDefinition[] = ROLE_KEYS.map(
  (key) => ROLE_DEFINITIONS[key],
);

export function roleHasPermission(role: RoleKey, permission: PermissionKey): boolean {
  return ROLE_DEFINITIONS[role].permissions.includes(permission);
}

/**
 * Resolves the effective permission set for a user's roles. Unknown or
 * duplicate roles are ignored; the result is stable-sorted so responses and
 * tests are deterministic.
 */
export function permissionsForRoles(roles: readonly RoleKey[]): PermissionKey[] {
  const effective = new Set<PermissionKey>();
  for (const role of roles) {
    for (const permission of ROLE_DEFINITIONS[role].permissions) {
      effective.add(permission);
    }
  }
  return [...effective].sort();
}

export function isRoleKey(value: string): value is RoleKey {
  return (ROLE_KEYS as readonly string[]).includes(value);
}

export function isPermissionKey(value: string): value is PermissionKey {
  return (PERMISSION_KEYS as readonly string[]).includes(value);
}
