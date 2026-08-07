/**
 * /v1 routes — the API the AI Betting Assistant consumes.
 *
 * Transport-free by design: this returns { status, body } plain objects rather
 * than Response objects, so the Cloudflare Worker, the local dev server and the
 * validation harness all drive the SAME handler. Anything that needs network is
 * injected via `deps`, which is what lets the tests run offline.
 *
 *   GET /v1/matches?q=arsenal+chelsea   -> candidate fixtures (no odds)
 *   GET /v1/matches/today               -> today's card in Lusaka time (no odds)
 *   GET /v1/match/:eventId              -> one fixture: full BwanaBet markets
 *                                          (with refs) + ranked comparison
 *
 * Search endpoints deliberately omit odds. Resolving prices for every candidate
 * would mean one Altenar event call per result on a query that is usually just
 * disambiguation; the caller picks a fixture, then asks for /v1/match/:id.
 */

import { buildMatchView } from '../lib/display.mjs';

const MATCH_PATH = /^\/v1\/match\/([^/]+)$/;

function summarize(e) {
    return {
        eventId: e.eventId,
        eventName: e.eventName,
        competition: e.competitionName || null,
        country: e.country || null,
        kickoffUtc: e.eventStartTime,
    };
}

export async function handleV1(pathname, searchParams, deps) {
    if (pathname === '/v1/matches/today') {
        const events = await deps.getTodayEvents();
        return { status: 200, body: { matches: events.map(summarize) } };
    }

    if (pathname === '/v1/matches') {
        const q = (searchParams.get('q') || '').trim();
        if (!q) return { status: 400, body: { error: 'q is required' } };
        const events = await deps.findEventsByTeams(q.toLowerCase());
        return { status: 200, body: { query: q, matches: events.map(summarize) } };
    }

    const m = MATCH_PATH.exec(pathname);
    if (m) {
        const rawId = m[1];
        if (!/^\d+$/.test(rawId)) return { status: 400, body: { error: 'eventId must be numeric' } };

        const [detail, competitorIndex] = await Promise.all([
            deps.getEventDetail(rawId),
            // A competitor-feed outage must not take the fixture down with it: the
            // caller still gets BwanaBet's markets, just without a comparison.
            deps.getCompetitorIndex().catch(() => ({})),
        ]);
        if (!detail) return { status: 404, body: { error: `event ${rawId} not found` } };

        return {
            status: 200,
            body: buildMatchView({
                event: detail.event,
                collections: detail.collections,
                competitorIndex,
            }),
        };
    }

    return { status: 404, body: { error: 'not found' } };
}
