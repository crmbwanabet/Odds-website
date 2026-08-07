/**
 * Bookmaker registry — the one place keys and display names are defined.
 *
 * These were duplicated between index.html (the COMPETITORS array) and
 * worker/validate.mjs (a bare COMP_KEYS list). The /v1 API returns book names to
 * a chatbot that reads them aloud to users, so a third copy would be a third
 * chance to drift.
 *
 * BwanaBet is deliberately NOT in COMP_KEYS: it is the reference price every
 * competitor is matched and capped against, never a row in the competitor list.
 */

export const BWANABET_KEY = 'bwanabet';

export const BOOK_NAMES = {
    bwanabet: 'BwanaBet',
    sportybet: 'SportyBet',
    onexbet: '1xBet',
    betway: 'Betway',
    betpawa: 'BetPawa',
    bolabet: 'BolaBet',
};

// Order matters only for stable output; ranking is by total payout at runtime.
export const COMP_KEYS = ['sportybet', 'onexbet', 'betway', 'betpawa', 'bolabet'];

export function bookName(key) {
    return BOOK_NAMES[key] || key;
}
