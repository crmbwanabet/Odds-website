/**
 * OddsZone competitor-odds proxy — Cloudflare Worker entry.
 *
 * WHY: The site reads BwanaBet directly (its Altenar feed is CORS-open). Every
 * other Zambian bookmaker's feed is CORS-locked, so a browser can't read it.
 * This Worker fetches those feeds server-to-server and re-serves them WITH a
 * CORS header. It invents nothing — see adapters.mjs.
 *
 *   GET /odds            -> { updatedAt, books: { sportybet, onexbet, betway } }
 *   GET /odds?book=betway  (filter to one book)
 *
 * Deploy: `wrangler deploy` (see README.md in this folder). Then set
 * CONFIG.PROXY_URL in ../index.html to the deployed Worker URL.
 */

import { collectAll } from './adapters.mjs';

const CACHE_TTL_MS = 45 * 1000;
let CACHE = { at: 0, data: null };

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
    if (url.pathname !== '/odds' && url.pathname !== '/') return cors(json({ error: 'not found' }, 404));

    const now = Date.now();
    if (!CACHE.data || now - CACHE.at > CACHE_TTL_MS) CACHE = { at: now, data: await collectAll() };

    const only = url.searchParams.get('book');
    const books = only ? { [only]: CACHE.data[only] || [] } : CACHE.data;
    return cors(json({ updatedAt: new Date(CACHE.at).toISOString(), books }));
  }
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
function cors(res) {
  const h = new Headers(res.headers);
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  h.set('Access-Control-Allow-Headers', '*');
  h.set('Cache-Control', 'public, max-age=30');
  return new Response(res.body, { status: res.status, headers: h });
}
