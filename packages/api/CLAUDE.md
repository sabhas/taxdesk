# API notes

- Every `/api/v1` route must declare exactly one access policy with `protect()`
  (`public`, `session`, `self_service`, `permission`, `any_permission`, or
  `self_or_permission`).
  `routes/route-policy.test.ts` fails if a route lacks one, and
  `routes/authorization.test.ts` drives every built-in role against every permission.
- A new repository needs both implementations: `repositories/postgres.ts` and
  `repositories/in-memory.ts` (the test harness uses the in-memory one), against the
  interfaces in `repositories/ports.ts`.
- Document storage goes only through `storage/provider.ts` (`DocumentStorageProvider`);
  only `storage/provider-factory.ts` may import `storage/onedrive/`, and
  `storage/boundary.test.ts` enforces it. Route tests use the fake provider from the
  harness and `connectStorage(harness, admin)` for a real connected gateway.
