// Tiny booker proxy: keeps the API key server-side. The browser POSTs its world state
// and gets back the next episode (LLM-booked, or offline-booked if the LLM fails).
import { createServer } from 'node:http';

try {
  process.loadEnvFile();
} catch {
  // no .env file; rely on the environment
}

const { bookEpisode, createPromotion, llmAvailable, model, planModel } = await import('./booker');
const PORT = Number(process.env.PORT || 8787);
const MAX_BODY = 2_000_000;

const server = createServer(async (req, res) => {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  try {
    if (req.method === 'GET' && req.url === '/api/health') {
      return send(200, { ok: true, llm: llmAvailable(), model: model(), planModel: planModel() });
    }
    if (req.method === 'POST' && (req.url === '/api/episode' || req.url === '/api/promotion')) {
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > MAX_BODY) return send(413, { error: 'request too large' });
      }
      const body = JSON.parse(raw);
      if (req.url === '/api/promotion') {
        const direction = String(body.direction ?? '').slice(0, 2000);
        const seed = Number(body.seed) >>> 0;
        const t0 = Date.now();
        const created = await createPromotion(direction, seed);
        if (!created.world) return send(503, { error: created.reason, message: created.message });
        console.error(`[server] promotion "${created.world.showName}" created by ${created.source} in ${Date.now() - t0}ms`);
        return send(200, created);
      }
      const { world } = body;
      if (!world || world.version !== 2) return send(400, { error: 'missing or invalid world' });
      const t0 = Date.now();
      const booked = await bookEpisode(world);
      if (!booked.episode) {
        console.error(`[server] episode ${world.episode + 1} unavailable: ${booked.message}`);
        return send(503, { error: booked.reason, message: booked.message });
      }
      console.error(`[server] episode ${world.episode + 1} booked by ${booked.source} in ${Date.now() - t0}ms`);
      return send(200, booked);
    }
    send(404, { error: 'not found' });
  } catch (err) {
    console.error('[server]', err);
    send(500, { error: (err as Error).message });
  }
});

server.listen(PORT, () => {
  console.error(`[server] booker proxy on http://localhost:${PORT} — ${llmAvailable() ? `LLM: ${model()}` : 'no API key: stored shows only'}`);
});
