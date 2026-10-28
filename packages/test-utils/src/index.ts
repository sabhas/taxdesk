import { vi } from 'vitest';

export function createJsonResponse(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

export function mockFetchJson(data: unknown, init?: ResponseInit): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createJsonResponse(data, init)));
}
