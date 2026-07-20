/**
 * Competitor odds adapters — shared by the Cloudflare Worker (odds-proxy.js)
 * and the local dev server (dev-server.mjs).
 *
 * Each adapter fetches ONE bookmaker's own live football feed server-to-server
 * and returns a list of normalized events:
 *   { home, away, start, odds: { home, draw, away } }   // odds are "2.35"-style strings or null
 *
 * Nothing is invented. Every price is the bookmaker's own live 1X2 coefficient.
 * A book that errors returns [] and is simply omitted from the comparison.
 *
 * Verified real & clean: SportyBet, 1xBet.
 * Best-effort (self-filters via team-matching in the UI): Betway (Highlights feed
 * also carries esports/virtual games; those never match a real fixture, and the
 * validity filter drops suspended 0.00 prices).
 * Held out of v1: BetPawa (protobuf heuristic — decodes team names reliably but
 * odds pairing is unverified, so we don't attribute possibly-wrong numbers to it).
 */

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 12000;

export async function collectAll() {
  const [sportybet, onexbet, betway] = await Promise.all([
    safe(fetchSportyBet), safe(fetchOneXBet), safe(fetchBetway)
  ]);
  return { sportybet, onexbet, betway };
}

async function safe(fn) { try { return await fn(); } catch (e) { return []; } }

// ---------- SportyBet ----------
export async function fetchSportyBet() {
  const url = 'https://www.sportybet.com/api/zm/factsCenter/pcUpcomingEvents'
    + '?sportId=sr%3Asport%3A1&marketId=1&pageSize=100&pageNum=1&option=1';
  const r = await timedFetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': 'https://www.sportybet.com/zm/sport/football' } });
  const j = await r.json();
  const out = [];
  for (const t of (j.data && j.data.tournaments) || []) {
    for (const e of t.events || []) {
      const m = (e.markets || []).find(x => x.id === '1'); // 1 = 1X2
      if (!m) continue;
      const pick = id => { const o = (m.outcomes || []).find(x => x.id === id); return o && o.odds ? String(o.odds) : null; };
      const ev = normalize(e.homeTeamName, e.awayTeamName, e.estimateStartTime, pick('1'), pick('2'), pick('3'));
      if (valid(ev)) out.push(ev);
    }
  }
  return out;
}

// ---------- 1xBet ----------
export async function fetchOneXBet() {
  const url = 'https://1xbet.com.zm/service-api/LineFeed/Get1x2_VZip'
    + '?sports=1&count=100&lng=en&mode=4&country=67&getEmpty=true&virtualSports=true';
  const r = await timedFetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': 'https://1xbet.com.zm/en/line/football' } });
  const j = await r.json();
  const out = [];
  for (const e of j.Value || []) {
    const m = {};
    for (const x of e.E || []) if (x.T === 1 || x.T === 2 || x.T === 3) m[x.T] = x.C;
    const ev = normalize(e.O1, e.O2, (e.S || 0) * 1000, fmt(m[1]), fmt(m[2]), fmt(m[3]));
    if (valid(ev)) out.push(ev);
  }
  return out;
}

// ---------- Betway ----------
export async function fetchBetway() {
  const url = 'https://www.betway.co.zm/sportsapi/br/v1/BetBook/Highlights/'
    + '?countryCode=ZM&sportId=soccer&Skip=0&Take=80&cultureCode=en-US&isEsport=false&boostedOnly=false&marketTypes=%5BWin%2FDraw%2FWin%5D';
  const r = await timedFetch(url, { headers: { 'User-Agent': UA, 'Accept': '*/*', 'Referer': 'https://www.betway.co.zm/sport/soccer' } });
  const j = await r.json();
  const priceByOutcome = {};
  for (const p of j.prices || []) priceByOutcome[p.outcomeId] = p.priceDecimal;
  const outcomesByMarket = {};
  for (const o of j.outcomes || []) (outcomesByMarket[o.marketId] ||= []).push(o);
  const marketByEvent = {};
  for (const m of j.markets || []) if (m.displayName === '1X2' || m.name === '[Win/Draw/Win]') marketByEvent[m.eventId] = m.marketId;
  const out = [];
  for (const e of j.events || []) {
    const marketId = marketByEvent[e.eventId];
    if (!marketId) continue;
    const os = (outcomesByMarket[marketId] || []).slice().sort((a, b) => a.index - b.index);
    if (os.length < 3) continue;
    const [h, d, a] = os; // index order: home, draw, away
    const name = e.name || e.displayName || '';
    const parts = name.split(/\s+vs?\.?\s+/i);
    const ev = normalize(parts[0] || name, parts[1] || '', (e.expectedStartEpoch || 0) * 1000,
      fmt(priceByOutcome[h.outcomeId]), fmt(priceByOutcome[d.outcomeId]), fmt(priceByOutcome[a.outcomeId]));
    if (valid(ev)) out.push(ev);
  }
  return out;
}

// ---------- helpers ----------
function normalize(home, away, startMs, h, d, a) {
  return {
    home: String(home || '').trim(),
    away: String(away || '').trim(),
    start: startMs ? new Date(Number(startMs)).toISOString() : null,
    odds: { home: h || null, draw: d || null, away: a || null }
  };
}
// A usable 1X2 row: all three prices present and > 1.0 (a decimal odd is always
// > 1.0; 0.00 / null means suspended or missing — drop it rather than show it).
function valid(ev) {
  const o = ev.odds;
  return ['home', 'draw', 'away'].every(k => o[k] != null && Number(o[k]) > 1.0)
    && ev.home.length > 1 && ev.away.length > 1;
}
function fmt(v) { return v == null ? null : String(Number(v).toFixed(2)); }
async function timedFetch(url, opts) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { ...opts, signal: c.signal });
    if (!r.ok) throw new Error('status ' + r.status);
    return r;
  } finally { clearTimeout(t); }
}
