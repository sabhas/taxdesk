import {
  ClientActivityListSchema,
  ClientAssigneeListSchema,
  ClientDuplicateCheckResponseSchema,
  ClientListSchema,
  ClientSchema,
  type Client,
  type ClientActivityList,
  type ClientAssigneeList,
  type ClientCreateRequest,
  type ClientDuplicateCheckResponse,
  type ClientList,
  type ClientType,
  type ClientUpdateRequest,
} from '@taxdesk/shared';
import { apiRequest } from './api-client.js';

/** Thin client for `/api/v1/clients`. The API enforces every rule. */

export interface ClientListParameters {
  readonly q?: string;
  readonly type?: ClientType;
  readonly manager?: string;
  readonly state?: 'active' | 'archived' | 'all';
  readonly limit?: number;
  readonly cursor?: string | null;
}

function signalOption(signal: AbortSignal | undefined) {
  return signal === undefined ? {} : { signal };
}

function clientPath(clientId: string, suffix = ''): string {
  return `/api/v1/clients/${encodeURIComponent(clientId)}${suffix}`;
}

export async function listClients(
  input: ClientListParameters,
  signal?: AbortSignal,
): Promise<ClientList> {
  const parameters = new URLSearchParams();
  if (input.q !== undefined && input.q.trim().length > 0) parameters.set('q', input.q.trim());
  if (input.type !== undefined) parameters.set('type', input.type);
  if (input.manager !== undefined) parameters.set('manager', input.manager);
  if (input.state !== undefined) parameters.set('state', input.state);
  parameters.set('limit', String(input.limit ?? 25));
  if (input.cursor !== undefined && input.cursor !== null) parameters.set('cursor', input.cursor);
  return await apiRequest(`/api/v1/clients?${parameters.toString()}`, ClientListSchema, {
    sessionScoped: true,
    ...signalOption(signal),
  });
}

export async function listClientAssignees(signal?: AbortSignal): Promise<ClientAssigneeList> {
  return await apiRequest('/api/v1/clients/assignees', ClientAssigneeListSchema, {
    sessionScoped: true,
    ...signalOption(signal),
  });
}

export async function getClient(clientId: string, signal?: AbortSignal): Promise<Client> {
  return await apiRequest(clientPath(clientId), ClientSchema, {
    sessionScoped: true,
    ...signalOption(signal),
  });
}

export async function checkClientDuplicates(
  request: ClientCreateRequest,
): Promise<ClientDuplicateCheckResponse> {
  return await apiRequest('/api/v1/clients/duplicate-check', ClientDuplicateCheckResponseSchema, {
    method: 'POST',
    body: request,
    sessionScoped: true,
  });
}

export async function createClient(request: ClientCreateRequest): Promise<Client> {
  return await apiRequest('/api/v1/clients', ClientSchema, {
    method: 'POST',
    body: request,
    sessionScoped: true,
  });
}

export async function updateClient(
  clientId: string,
  request: ClientUpdateRequest,
  version: number,
): Promise<Client> {
  return await apiRequest(clientPath(clientId), ClientSchema, {
    method: 'PATCH',
    body: request,
    ifMatch: version,
    sessionScoped: true,
  });
}

export async function setClientArchived(
  clientId: string,
  archived: boolean,
  version: number,
): Promise<Client> {
  return await apiRequest(clientPath(clientId, archived ? '/archive' : '/restore'), ClientSchema, {
    method: 'POST',
    ifMatch: version,
    sessionScoped: true,
  });
}

export async function listClientActivity(
  clientId: string,
  input: { cursor?: string | null; limit?: number } = {},
  signal?: AbortSignal,
): Promise<ClientActivityList> {
  const parameters = new URLSearchParams();
  parameters.set('limit', String(input.limit ?? 20));
  if (input.cursor !== undefined && input.cursor !== null) parameters.set('cursor', input.cursor);
  return await apiRequest(
    `${clientPath(clientId, '/activity')}?${parameters.toString()}`,
    ClientActivityListSchema,
    { sessionScoped: true, ...signalOption(signal) },
  );
}
