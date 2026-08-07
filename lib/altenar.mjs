/**
 * Server-side Altenar (BwanaBet) client.
 *
 * This is a port of the browser code currently inline in ../index.html. The site
 * can fetch Altenar directly because that feed is CORS-open; the Worker needs the
 * same calls server-side so the /v1 API can serve a chatbot, which has no browser.
 *
 * This is the ONLY file in the repo that talks to BwanaBet. Everything else works
 * on the data it returns.
 *
 * `fetchImpl` is injectable purely so the tests can run without network.
 */

export const ALTENAR_API = 'https://api.bwanabet.co.zm/api/v2/multi';
export const SPORT_FOOTBALL = 501;
export const PAGE_LIMIT = 100;
export const SEARCH_MAX_PAGES = 6;
export const MAX_RESULTS = 8;
export const REQUEST_TIMEOUT_MS = 10000;

// Zambia is UTC+2 year-round — no daylight saving — so a fixed offset is correct
// here and avoids depending on Intl timezone data inside a Worker isolate.
export const LUSAKA_OFFSET_MS = 2 * 60 * 60 * 1000;

export async function multiQuery(query, { fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
        const res = await fetchImpl(ALTENAR_API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify([{ module: 'graphs', method: 'makeQuery', options: { query } }]),
            signal: ctl.signal,
        });
        if (!res.ok) throw new Error('Altenar HTTP ' + res.status);
        const data = await res.json();
        if (!Array.isArray(data) || !data[0] || data[0].error) throw new Error('Altenar bad response');
        return data[0].data;
    } finally {
        clearTimeout(timer);
    }
}

export async function getMainEvents(page, opts = {}) {
    const q = `mutation { mainEventList(mainEventListInput: { topEvents: false page: ${Number(page)} sportId: ${SPORT_FOOTBALL} limit: ${PAGE_LIMIT} }) { competitions { competitionId country competitionName events { eventId eventName eventStartTime top pricesCount } } } }`;
    const data = await multiQuery(q, opts);
    const sport = data?.mainEventList?.[0];
    const out = [];
    for (const comp of sport?.competitions || []) {
        for (const e of comp.events || []) {
            out.push({
                eventId: e.eventId,
                eventName: e.eventName,
                eventStartTime: e.eventStartTime,
                top: e.top === true,
                competitionName: comp.competitionName,
                country: comp.country,
            });
        }
    }
    return out;
}

export async function getEventDetail(eventId, opts = {}) {
    const id = Number.parseInt(eventId, 10);
    if (!Number.isFinite(id)) return null;
    const q = `mutation { eventList(eventListInput: { eventId: ${id} }) { competitions { competitionId country competitionName events { eventId eventName eventStartTime collections { collectionId collectionName markets { marketId marketName marketCode prices { referenceId priceName handicapValue rate blocked } } } } } } }`;
    const data = await multiQuery(q, opts);
    const comp = data?.eventList?.[0]?.competitions?.[0];
    const event = comp?.events?.[0];
    if (!event) return null;
    return {
        event: {
            eventId: event.eventId,
            eventName: event.eventName,
            eventStartTime: event.eventStartTime,
            competitionName: comp.competitionName,
            country: comp.country,
        },
        collections: event.collections || [],
    };
}

export async function findEventsByTeams(rawQuery, opts = {}) {
    const raw = String(rawQuery || '').toLowerCase().trim();
    if (!raw) return [];
    const parts = raw.split(/\s+(?:vs?\.?|-)\s+/).map(s => s.trim()).filter(Boolean);
    const tokens = parts.length >= 2 ? parts.slice(0, 2) : [raw];
    const enough = tokens.length >= 2 ? 2 : MAX_RESULTS;

    const matches = [], seen = new Set();
    for (let page = 1; page <= SEARCH_MAX_PAGES; page++) {
        let events;
        try { events = await getMainEvents(page, opts); } catch { break; }
        if (!events.length) break;
        for (const e of events) {
            const name = String(e.eventName).toLowerCase();
            const ok = tokens.length >= 2 ? tokens.every(t => name.includes(t)) : name.includes(tokens[0]);
            if (ok && !seen.has(e.eventId)) { seen.add(e.eventId); matches.push(e); }
        }
        if (matches.length >= enough) break;
    }
    return matches
        .sort((a, b) => new Date(a.eventStartTime) - new Date(b.eventStartTime))
        .slice(0, MAX_RESULTS);
}

// Same calendar day in Lusaka, not UTC — a 23:00Z kickoff is already tomorrow
// locally, and users ask "what's on today" in their own day.
export function isToday(iso, now = new Date()) {
    const day = (d) => new Date(new Date(d).getTime() + LUSAKA_OFFSET_MS).toISOString().slice(0, 10);
    return day(iso) === day(now);
}

export async function getTodayEvents(opts = {}) {
    const out = [], seen = new Set();
    for (let page = 1; page <= SEARCH_MAX_PAGES; page++) {
        let events;
        try { events = await getMainEvents(page, opts); } catch { break; }
        if (!events.length) break;
        for (const e of events) {
            if (isToday(e.eventStartTime) && !seen.has(e.eventId)) { seen.add(e.eventId); out.push(e); }
        }
    }
    return out.sort((a, b) => new Date(a.eventStartTime) - new Date(b.eventStartTime));
}
