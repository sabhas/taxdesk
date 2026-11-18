import { resolve } from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';
import {
  HELP_BASE_PATH,
  TRAINING_GUIDE_DIR,
  buildHelpSite,
  helpContentType,
  writeHelpSite,
} from './help-site.js';

/**
 * TD-806: publishes the staff help bundle at `/help/`.
 *
 * `vite build` writes it into `dist/help/`; the Pages Function serves it only to
 * signed-in sessions. `vite dev` serves it from memory without the sign-in check
 * (the Pages Function does not run under Vite), rebuilt on every request so
 * guide edits show up on refresh.
 */
export function helpSite(sourceDir: string = TRAINING_GUIDE_DIR): Plugin {
  let config: ResolvedConfig | undefined;
  return {
    name: 'taxdesk-help-site',
    configResolved(resolved) {
      config = resolved;
    },
    async closeBundle() {
      if (config?.command !== 'build' || config.build.ssr !== false) {
        return;
      }
      await writeHelpSite(
        resolve(config.root, config.build.outDir),
        await buildHelpSite(sourceDir),
      );
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
        if (pathname === '/help') {
          response.statusCode = 308;
          response.setHeader('Location', HELP_BASE_PATH);
          response.end();
          return;
        }
        if (!pathname.startsWith(HELP_BASE_PATH)) {
          next();
          return;
        }
        let path = decodeURIComponent(pathname.slice(HELP_BASE_PATH.length));
        if (path === '' || path.endsWith('/')) {
          path += 'index.html';
        }
        buildHelpSite(sourceDir).then(
          (files) => {
            const content = files.get(path) ?? files.get(`${path}.html`);
            if (content === undefined) {
              response.statusCode = 404;
              response.setHeader('Content-Type', 'text/plain; charset=utf-8');
              response.end('Help page not found.');
              return;
            }
            const served = files.has(path) ? path : `${path}.html`;
            response.setHeader('Content-Type', helpContentType(served));
            response.setHeader('Cache-Control', 'no-store');
            response.end(content);
          },
          (error: unknown) => {
            next(error);
          },
        );
      });
    },
  };
}
