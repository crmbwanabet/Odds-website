/**
 * OddsZone competitor-odds proxy — Cloudflare Worker entry.
 *
 * WHY: The site reads BwanaBet directly (its Altenar feed is CORS-open). Every
 * other Zambian bookmaker's feed is CORS-locked, so a browser can't read it. This
 * Worker fetches those feeds server-to-server and re-serves them WITH a CORS header.
 * It invents nothing — see adapters.mjs.
 *
 *   GET /odds            -> { updatedAt, books: { sportybet, onexbet, betway, betpawa, bolabet } }
 *   GET /odds?book=betway  (filter to one book)
 *
 * TRAFFIC MODEL (three cache layers so heavy traffic never fans out to the 5
 * bookmaker feeds more than it must):
 *   L1  in-isolate memory      — instant, but private to one Worker isolate.
 *   L2  Cloudflare Cache API    — shared by all isolates in a datacenter; this is
 *                                 what keeps a spike from re-fetching upstream on
 *                                 every cold isolate. Only ~one fan-out per colo per
 *                                 TTL instead of one per request.
 *   L3  live fan-out (adapters) — populates L1+L2. Concurrent misses in an isolate
 *                                 are coalesced into a single in-flight fetch.
 *
 * Deploy: `wrangler deploy` (see README.md). Then set CONFIG.PROXY_URL in
 * ../index.html to the deployed Worker URL.
 */

import { collectAll } from './adapters.mjs';
import { handleV1 } from './v1.mjs';
import { buildIndex } from '../lib/odds-match.mjs';
import { getEventDetail, findEventsByTeams, getTodayEvents } from '../lib/altenar.mjs';

const TTL_MS = 45 * 1000;
let MEM = { at: 0, doc: null };   // L1 (per-isolate)
let INFLIGHT = null;              // coalesces concurrent L3 fan-outs in one isolate

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
    if (url.pathname.startsWith('/v1/')) {
      const deps = {
        // Reuses the same three-layer cached competitor doc as /odds, so the
        // chatbot's traffic never adds upstream fan-out of its own.
        getCompetitorIndex: async () => buildIndex((await getDoc(ctx, url.origin)).books),
        getEventDetail,
        findEventsByTeams,
        getTodayEvents,
      };
      let result;
      try {
        result = await handleV1(url.pathname, url.searchParams, deps);
      } catch (e) {
        result = { status: 502, body: { error: 'upstream odds feed unavailable', detail: String(e && e.message || e) } };
      }
      return cors(json(result.body, result.status));
    }

    if (url.pathname !== '/odds' && url.pathname !== '/') return cors(json({ error: 'not found' }, 404));

    const doc = await getDoc(ctx, url.origin);

    const only = url.searchParams.get('book');
    const books = only ? { [only]: doc.books[only] || [] } : doc.books;
    return cors(json({ updatedAt: doc.updatedAt, books }));
  }
};

// Return the full { updatedAt, books } doc, freshest-cheap-source first.
async function getDoc(ctx, origin) {
  const now = Date.now();
  if (MEM.doc && now - MEM.at <= TTL_MS) return MEM.doc;               // L1

  const cache = caches.default;
  // Fixed key (ignore ?book) so the whole doc is cached once and filtered per-request.
  const key = new Request(origin + '/odds', { method: 'GET' });
  const hit = await cache.match(key);                                  // L2
  if (hit) {
    const doc = await hit.json();
    MEM = { at: now, doc };
    return doc;
  }

  if (!INFLIGHT) {                                                     // L3 (coalesced)
    INFLIGHT = (async () => {
      const doc = { updatedAt: new Date(Date.now()).toISOString(), books: await collectAll() };
      MEM = { at: Date.now(), doc };
      const store = new Response(JSON.stringify(doc), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${TTL_MS / 1000}` }
      });
      ctx.waitUntil(cache.put(key, store));
      return doc;
    })().finally(() => { INFLIGHT = null; });
  }
  return INFLIGHT;
}

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
