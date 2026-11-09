import type { ApiBindings } from './config.js';
import type { AppDependencies } from './dependencies.js';
import type { Actor } from './domain/auth/types.js';

export interface AppEnv {
  Bindings: ApiBindings;
  Variables: {
    requestId: string;
    dependencies: AppDependencies;
    actor: Actor;
    sessionToken: string;
  };
}
