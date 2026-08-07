/**
 * Display assembly — turns one Altenar event plus the competitor index into the
 * exact view the site renders, which is the ONLY thing the /v1 API is allowed to
 * return.
 *
 * The chatbot must never see a raw bookmaker price. It sees what a visitor to the
 * odds site would see: BwanaBet's real prices, and competitor prices that have
 * been matched, capped (capOddsAgainstBwana) and filtered (beatenBooks) by the
 * site's own pipeline. That pipeline lives in odds-match.mjs and is reused here
 * rather than reimplemented, so the API and the site cannot drift.
 *
 * Pure — no network. Callers fetch the event and the competitor index.
 */

import {
    extract1x2, splitTeams, matchCompetitors, beatenBooks, totalPayout,
} from './odds-match.mjs';
import { extractMarkets } from './markets.mjs';
import { BOOK_NAMES, COMP_KEYS, BWANABET_KEY, bookName } from './books.mjs';

// BwanaBet first, then the books it beats, richest total payout first.
// BwanaBet always heads this list by construction: every competitor price has
// already been capped at (bwanabet - 0.03) upstream.
export function rankBooks(bwanaOdds, rows) {
    const entries = [{
        book: BWANABET_KEY,
        name: BOOK_NAMES[BWANABET_KEY],
        odds: bwanaOdds,
        total: totalPayout(bwanaOdds),
        placeable: true,
    }];
    for (const r of rows) {
        entries.push({
            book: r.key,
            name: bookName(r.key),
            odds: r.odds,
            total: totalPayout(r.odds),
            placeable: false,
        });
    }
    return entries.sort((a, b) => (b.total ?? -Infinity) - (a.total ?? -Infinity));
}

export function buildMatchView({ event, collections, competitorIndex, compKeys = COMP_KEYS }) {
    const markets = extractMarkets(collections);
    const odds1x2 = extract1x2(collections);
    const teams = splitTeams(event.eventName);

    const rows = odds1x2
        ? matchCompetitors(teams.home, teams.away || '', competitorIndex, compKeys, odds1x2)
        : [];
    const beaten = odds1x2 ? beatenBooks(odds1x2, rows) : [];

    return {
        eventId: event.eventId,
        eventName: event.eventName,
        homeTeam: teams.home,
        awayTeam: teams.away || 'TBA',
        competition: event.competitionName || null,
        country: event.country || null,
        kickoffUtc: event.eventStartTime,
        // Full BwanaBet market set. Every selection carries `ref` (referenceId),
        // which the betslip handoff needs to build a placeable slip.
        markets,
        // 1X2 only — the sole market with competitor data.
        odds1x2,
        comparison: odds1x2 ? rankBooks(odds1x2, beaten) : [],
        // False is NORMAL, not an error: beatenBooks() returns empty whenever
        // BwanaBet does not win on total payout. Consumers must present that as
        // "no comparison for this fixture", never as a failure.
        comparisonAvailable: beaten.length > 0,
    };
}
