/**
 * Local dev server — runs the SAME adapters as the Cloudflare Worker, so the
 * comparison UI can be tested end-to-end before deploying anything.
 *
 *   node worker/dev-server.mjs            # serves http://localhost:8787/odds
 *
 * Point CONFIG.PROXY_URL in index.html at http://localhost:8787 during local dev.
 * Node 18+ (global fetch) required.
 */
import { createServer } from 'node:http';
import { collectAll } from './adapters.mjs';

const PORT = process.env.PORT || 8787;
const CACHE_TTL_MS = 45 * 1000;
let CACHE = { at: 0, data: null };

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (url.pathname !== '/odds' && url.pathname !== '/') { res.writeHead(404); return res.end('{"error":"not found"}'); }

  const now = Date.now();
  if (!CACHE.data || now - CACHE.at > CACHE_TTL_MS) {
    console.log('[dev-server] refreshing competitor feeds…');
    CACHE = { at: now, data: await collectAll() };
    const counts = Object.entries(CACHE.data).map(([k, v]) => `${k}=${v.length}`).join(' ');
    console.log('[dev-server] ' + counts);
  }
  const only = url.searchParams.get('book');
  const books = only ? { [only]: CACHE.data[only] || [] } : CACHE.data;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ updatedAt: new Date(CACHE.at).toISOString(), books }));
}).listen(PORT, () => console.log(`[dev-server] odds proxy on http://localhost:${PORT}/odds`));
