import { HealthSchema, ProblemDetailsSchema, type Health } from '@taxdesk/shared';

export type HealthLoadResult =
  { status: 'success'; health: Health } | { status: 'failure'; requestId?: string };

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function responseRequestId(response: Response): string | undefined {
  return response.headers.get('X-Request-Id') ?? undefined;
}

/**
 * Calls the same-origin health endpoint and validates both success and failure
 * payloads. Callers receive only public health data or a safe reference ID;
 * invalid payloads and network failures collapse to a generic failure state.
 */
export async function loadHealth(
  fetcher: typeof fetch = globalThis.fetch,
): Promise<HealthLoadResult> {
  try {
    const response = await fetcher('/health', {
      headers: { Accept: 'application/json' },
    });
    const body = await readJson(response);

    if (!response.ok) {
      const problem = ProblemDetailsSchema.safeParse(body);
      const requestId = problem.success ? problem.data.requestId : responseRequestId(response);
      return requestId ? { status: 'failure', requestId } : { status: 'failure' };
    }

    const health = HealthSchema.safeParse(body);
    if (!health.success) {
      const requestId = responseRequestId(response);
      return requestId ? { status: 'failure', requestId } : { status: 'failure' };
    }

    return { status: 'success', health: health.data };
  } catch {
    return { status: 'failure' };
  }
}
