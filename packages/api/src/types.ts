import type { ApiBindings } from './config.js';

export interface AppEnv {
  Bindings: ApiBindings;
  Variables: {
    requestId: string;
  };
}
