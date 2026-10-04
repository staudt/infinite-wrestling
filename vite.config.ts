import { defineConfig, type Plugin } from 'vite';
import { exportLibrary, listLibrary, readStored } from './server/sessions.ts';

/**
 * Serves stored shows (sessions/ and library/) straight from the dev server, so saved
 * promotions play even when the booker server is down or there's no API key.
 *   GET /library/index.json            every stored show
 *   GET /library/<show id>/<file>.json   promotion.json or ep-NNN.json
 * In a production build (GitHub Pages), the committed library/ is emitted as the same
 * static files, so the demo plays stored shows with no server at all.
 */
function library(): Plugin {
  return {
    name: 'gptww-library',
    configureServer(server) {
      server.middlewares.use('/library', (req, res, next) => {
        const url = (req.url ?? '').split('?')[0];
        const send = (status: number, body: unknown) => {
          res.statusCode = status;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(body));
        };
        if (url === '/index.json') return send(200, listLibrary());
        const m = url.match(/^\/([a-z0-9-]+)\/((?:promotion|ep-\d{3})\.json)$/);
        if (!m) return next();
        const data = readStored(m[1], m[2]);
        return data ? send(200, data) : send(404, { error: 'not stored' });
      });
    },
    generateBundle() {
      for (const f of exportLibrary()) this.emitFile({ type: 'asset', fileName: f.path, source: f.content });
    },
  };
}

export default defineConfig({
  // Relative paths, so the build works from any subpath (e.g. GitHub Pages).
  base: './',
  plugins: [library()],
  server: {
    proxy: { '/api': 'http://localhost:8787' },
  },
});
