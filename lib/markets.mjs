/**
 * BwanaBet market extraction from an Altenar event's collections. Pure — no
 * network, no DOM.
 *
 * Ported from bet-assist's api/widget-chat.js (bwGetOdds), which is the proven
 * shape the betslip share-code handoff already consumes. Every selection carries
 * the referenceId; without it a pick cannot be placed, so a market with no refs
 * is worthless downstream.
 *
 * Two things that look like bugs and are not:
 *   - Only four of the Main collection's ~13 markets are surfaced. The rest
 *     (Correct Score, HT/FT, Next Goal, To Qualify...) are noise for a betting
 *     assistant and would bloat every tool result the model reads.
 *   - Over/Under is NOT in Main. It lives in the Goals collection as a single
 *     "OU" market holding every line from 0.5 upward; the 2.5 pair is selected by
 *     handicapValue. Beware: "OU" also appears in Corners, and Goals also holds
 *     per-team totals (IOU_T1/IOU_T2) that carry their own 2.5 line.
 */

// Markets taken from the "Main" collection.
export const MAIN_MARKET_CODES = ['1x2', 'DC', 'BTS', 'OE'];

// The only Over/Under line surfaced.
export const OU_HANDICAP = 2.5;

function toSelection(p, hcap) {
    return {
        label: String(p.priceName || '').trim(),
        odds: p.rate,
        ref: p.referenceId,
        hcap,
    };
}

function livePrices(prices) {
    return (prices || []).filter(p => !p.blocked && p.rate > 0);
}

export function extractMarkets(collections) {
    const list = collections || [];

    const main = list.find(c => c.collectionName === 'Main');
    const markets = (main?.markets || [])
        .filter(m => MAIN_MARKET_CODES.includes(m.marketCode))
        .map(m => ({
            marketCode: m.marketCode,
            marketName: m.marketName,
            selections: livePrices(m.prices).map(p => toSelection(p, 0)),
        }))
        .filter(m => m.selections.length > 0);

    // Scoped to the Goals collection so the Corners "OU" market can never leak in.
    const goals = list.find(c => c.collectionName === 'Goals');
    const ou = (goals?.markets || []).find(m => m.marketCode === 'OU');
    if (ou) {
        const line = livePrices(ou.prices).filter(p => p.handicapValue === OU_HANDICAP);
        if (line.length === 2) {
            markets.push({
                marketCode: 'OU_2.5',
                marketName: `Over/Under ${OU_HANDICAP} Goals`,
                selections: line.map(p => ({
                    ...toSelection(p, OU_HANDICAP),
                    label: `${String(p.priceName || '').trim()} ${OU_HANDICAP}`,
                })),
            });
        }
    }

    return markets;
}
