import type { UserRepository } from '../repositories/ports.js';
import type { UserRecord } from './auth/types.js';

export interface Person {
  readonly id: string;
  readonly displayName: string;
}

/**
 * Resolves user IDs to `{ id, displayName }` with a per-request cache. Only the
 * display name leaves the server; usernames and account state never do.
 */
export function personLookup(users: UserRepository): (id: string | null) => Promise<Person | null> {
  const cache = new Map<string, UserRecord | null>();
  return async (id) => {
    if (id === null) {
      return null;
    }
    if (!cache.has(id)) {
      cache.set(id, await users.findById(id));
    }
    const user = cache.get(id) ?? null;
    return user === null ? null : { id: user.id, displayName: user.displayName };
  };
}
