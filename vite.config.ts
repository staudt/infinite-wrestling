import { defineConfig, type Plugin } from 'vite';
import { listLibrary, readStored } from './server/sessions.ts';

/**
 * Serves stored shows (sessions/ and library/) straight from the dev server, so saved
 * promotions play even when the booker server is down or there's no API key.
 *   GET /library/index.json            every stored show
 *   GET /library/<seed>/<file>.json    promotion.json or ep-NNN.json
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
        const m = url.match(/^\/(\d+)\/((?:promotion|ep-\d{3})\.json)$/);
        if (!m) return next();
        const data = readStored(Number(m[1]), m[2]);
        return data ? send(200, data) : send(404, { error: 'not stored' });
      });
    },
  };
}

export default defineConfig({
  plugins: [library()],
  server: {
    proxy: { '/api': 'http://localhost:8787' },
  },
});
