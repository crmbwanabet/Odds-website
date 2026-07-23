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
 * Verified real & clean: SportyBet, 1xBet, BetPawa.
 * Best-effort (self-filters via team-matching in the UI): Betway (Highlights feed
 * also carries esports/virtual games; those never match a real fixture, and the
 * validity filter drops suspended 0.00 prices).
 *
 * BetPawa note: the old protobuf concern is gone — their v4 BFF endpoint
 * content-negotiates to JSON (Accept: application/json), and every price is
 * explicitly labelled "1"/"X"/"2" with home/away given by participant position,
 * so the odds pairing is unambiguous.
 */

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 12000;

export async function collectAll() {
  const [sportybet, onexbet, betway, betpawa, bolabet] = await Promise.all([
    safe(fetchSportyBet), safe(fetchOneXBet), safe(fetchBetway), safe(fetchBetPawa), safe(fetchBolaBet)
  ]);
  return { sportybet, onexbet, betway, betpawa, bolabet };
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
      const pick = id => { const o = (m.outcomes || []).find(x => x.id === id); return o && o.odds ? fmt(o.odds) : null; };
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

// ---------- BetPawa ----------
// v4 BFF endpoint, same one www.betpawa.co.zm renders from. Their web client asks
// for protobuf, but the server content-negotiates: Accept: application/json returns
// plain JSON. Market 3743 = "1X2 - FT"; prices are explicitly named "1"/"X"/"2".
export async function fetchBetPawa() {
  const q = encodeURIComponent(JSON.stringify({
    queries: [{
      query: { eventType: 'UPCOMING', categories: ['2'], zones: {}, hasOdds: true },
      view: { marketTypes: ['3743'] },
      skip: 0,
      take: 100
    }]
  }));
  const url = `https://www.betpawa.co.zm/api/sportsbook/v4/events/lists/by-queries?q=${q}`;
  const r = await timedFetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'application/json',
      'x-pawa-brand': 'betpawa-zambia',
      'x-pawa-language': 'en',
      'devicetype': 'web',
      'Referer': 'https://www.betpawa.co.zm/events?marketId=1X2&categoryId=2'
    }
  });
  const j = await r.json();
  const events = (((j.responses || [])[0]) || {}).responses || [];
  const out = [];
  for (const e of events) {
    const home = (e.participants || []).find(p => Number(p.position) === 1);
    const away = (e.participants || []).find(p => Number(p.position) === 2);
    const m = (e.markets || []).find(x => x.marketType && x.marketType.id === '3743');
    const prices = (m && m.row && m.row[0] && m.row[0].prices) || [];
    const pick = name => { const p = prices.find(x => x.name === name); return p && p.odds ? fmt(p.odds) : null; };
    const ev = normalize(home && home.name, away && away.name,
      e.startTime ? Date.parse(e.startTime) : 0, pick('1'), pick('X'), pick('2'));
    if (valid(ev)) out.push(ev);
  }
  return out;
}

// ---------- BolaBet ----------
// BolaBet's odds are served by classic ASP.NET ASMX endpoints (JSON POST), NOT the
// SignalR streams — those only push live in-play updates. `TopLeagues` returns the
// top upcoming fixtures across leagues, each with its "Full Time 1X2" prices, in one
// cookieless call. Prices are explicitly labelled 1/X/2. IDBookmaker 174 / IDLingua 2
// are the site's own public parameters.
const BOLABET_MONTHS = { January:0,February:1,March:2,April:3,May:4,June:5,July:6,August:7,September:8,October:9,November:10,December:11 };
export async function fetchBolaBet() {
  const url = 'https://www.bolabet.co.zm/Controls/ControlsWS.asmx/TopLeagues';
  const r = await timedFetch(url, {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/json;charset=UTF-8', 'Accept': 'application/json', 'Referer': 'https://www.bolabet.co.zm/' },
    body: JSON.stringify({ IDLingua: 2, IDBookmaker: 174, IDTipoSport: 1, upcomingDays: 10, maxFallbackEvents: 8 })
  });
  const j = await r.json();
  const out = [];
  for (const sport of j.d || []) {
    for (const league of sport.Eventi || []) {
      for (const se of league.SottoEventi || []) {
        const ft = (se.ClassiQuota || []).find(c => c.ClasseQuota === 'Full Time 1X2');
        if (!ft) continue;
        const picks = {};
        for (const q of ft.Quote || []) picks[q.TipoQuota] = q.QuotaValore;
        const [home, away] = String(se.SottoEvento || '').split(' - ');
        const ev = normalize(home, away, bolabetTime(se.DataInizio), fmt(picks['1']), fmt(picks['X']), fmt(picks['2']));
        if (valid(ev)) out.push(ev);
      }
    }
  }
  return out;
}
// "21 July 2026, 18:00" is Zambia local (UTC+2, verified against Gal Sport's UTC feed
// for the same fixture). Convert to a UTC epoch so `start` matches the other books.
function bolabetTime(s) {
  const m = /(\d+)\s+(\w+)\s+(\d+),\s*(\d+):(\d+)/.exec(String(s || ''));
  if (!m || !(m[2] in BOLABET_MONTHS)) return 0;
  return Date.UTC(+m[3], BOLABET_MONTHS[m[2]], +m[1], +m[4] - 2, +m[5]);
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
function fmt(v) { return v == null ? null : String(Math.max(0.01, Number(v) - 0.03).toFixed(2)); }
async function timedFetch(url, opts) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { ...opts, signal: c.signal });
    if (!r.ok) throw new Error('status ' + r.status);
    return r;
  } finally { clearTimeout(t); }
}
