/**
 * Pure fixture-matching + 1X2 odds decoding. NO DOM, NO network, no globals — so
 * the EXACT same logic runs in the browser (index.html) and in the test/validation
 * harness (worker/validate.mjs). One copy means the tests check the real code, and
 * the matcher can't silently drift away from what the site ships.
 */

// ---------- BwanaBet (Altenar) 1X2 decoding ----------

// Extract the 1X2 (Match Result) prices from an Altenar event's market collections.
// Blocked or zero-rate prices stay '-'.
export function extract1x2(collections) {
    if (!collections) return null;
    const main = collections.find(c => c.collectionName === 'Main');
    if (!main) return null;
    const market = (main.markets || []).find(m => m.marketCode === '1x2');
    if (!market) return null;
    const odds = { home: '-', draw: '-', away: '-' };
    for (const p of market.prices || []) {
        if (p.blocked || !(p.rate > 0)) continue;
        if (p.priceName === '1') odds.home = p.rate.toFixed(2);
        else if (p.priceName === 'X') odds.draw = p.rate.toFixed(2);
        else if (p.priceName === '2') odds.away = p.rate.toFixed(2);
    }
    return odds;
}

// Split "Home vs Away" (or "Home v Away") into team names.
export function splitTeams(eventName) {
    const parts = String(eventName).split(/\s+vs?\.?\s+/i);
    if (parts.length >= 2) {
        return { home: parts[0].trim(), away: parts.slice(1).join(' v ').trim() };
    }
    return { home: eventName, away: '' };
}

// ---------- team-name normalization + fuzzy matching ----------

// Tokens that don't help identify a club (legal suffixes, generic words, age/team
// qualifiers). Dropping them lets "FC Arsenal" match "Arsenal", etc.
export const TEAM_STOPWORDS = new Set(['fc', 'afc', 'cf', 'sc', 'ac', 'if', 'sk', 'fk', 'bk', 'club',
    'city', 'town', 'united', 'utd', 'the', 'de', 'do', 'da', 'e', 'u21', 'u20', 'u23', 'u19',
    'women', 'reserves', 'ii', 'b']);

// Common abbreviations collapsed to a canonical token before matching.
export const TEAM_ALIAS = { man: 'manchester', utd: 'united', psg: 'paris', inter: 'internazionale' };

// Reduce a team name to a set of identifying tokens.
export function normTeam(name) {
    const raw = String(name || '').toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')  // strip accents
        .replace(/[^a-z0-9\s]/g, ' ');
    const tokens = raw.split(/\s+/).filter(Boolean)
        .map(t => TEAM_ALIAS[t] || t)
        .filter(t => !TEAM_STOPWORDS.has(t) && t.length > 1);
    return new Set(tokens);
}

// Two tokens "match" if equal, OR one is a prefix of the other and the shorter is
// at least 4 chars. The prefix rule recovers truncated names that different books
// use — "brat" for "bratislava", "wolver" for "wolverhampton", "internazion" for
// "internazionale". The 4-char floor keeps short fragments ("st", "san", "real")
// from colliding, and the two-sided fixture threshold below means a single
// spurious token-match can never confirm a wrong fixture on its own.
export function tokensMatch(a, b) {
    if (a === b) return true;
    const [s, l] = a.length <= b.length ? [a, b] : [b, a];
    return s.length >= 4 && l.startsWith(s);
}

// Fraction of the smaller token-set that finds a match in the other set (0..1).
// Each token in the smaller set is counted at most once.
export function tokenOverlap(a, b) {
    if (!a.size || !b.size) return 0;
    const [small, big] = a.size <= b.size ? [a, b] : [b, a];
    let hit = 0;
    for (const t of small) {
        for (const u of big) { if (tokensMatch(t, u)) { hit++; break; } }
    }
    return hit / small.size;
}

// Does a competitor event refer to the same fixture as our card? Require a strong
// match on BOTH sides; allow home/away to be swapped (books order teams differently).
export function isSameFixture(cardNorm, ev) {
    const straight = Math.min(tokenOverlap(cardNorm.home, ev.norm.home), tokenOverlap(cardNorm.away, ev.norm.away));
    const swapped = Math.min(tokenOverlap(cardNorm.home, ev.norm.away), tokenOverlap(cardNorm.away, ev.norm.home));
    return { score: Math.max(straight, swapped), swapped: swapped > straight };
}

// A fixture is only confirmed when both sides clear this overlap.
export const MATCH_THRESHOLD = 0.7;

// ---------- odds math ----------

// Total payout for a 1X2 row = home + draw + away. null unless all three are real
// numeric prices; a suspended '–'/null makes the row incomparable.
export function totalPayout(odds) {
    if (!odds) return null;
    const nums = ['home', 'draw', 'away'].map(k => parseFloat(odds[k]));
    if (nums.some(n => isNaN(n))) return null;
    return nums[0] + nums[1] + nums[2];
}

// ---------- competitor index + matching ----------

// Precompute a competitor index from raw proxy `books` data, attaching the
// normalized token sets once so per-card matching stays cheap under load.
export function buildIndex(books) {
    const index = {};
    for (const [book, events] of Object.entries(books || {})) {
        index[book] = (events || []).map(e => ({
            home: e.home, away: e.away,
            norm: { home: normTeam(e.home), away: normTeam(e.away) },
            odds: e.odds
        }));
    }
    return index;
}

// For one card (home/away team names), find each competitor's odds for the SAME
// fixture. Returns [{ key, odds }] for the books that genuinely have the match,
// with home/away swapped back to the card's orientation where the book ordered
// them the other way. `keys` is the list of competitor keys to consider.
export function matchCompetitors(homeTeam, awayTeam, index, keys) {
    const cardNorm = { home: normTeam(homeTeam), away: normTeam(awayTeam) };
    const rows = [];
    for (const key of keys) {
        const events = index[key] || [];
        let best = null;
        for (const ev of events) {
            const m = isSameFixture(cardNorm, ev);
            if (m.score >= MATCH_THRESHOLD && (!best || m.score > best.score)) {
                const odds = m.swapped
                    ? { home: ev.odds.away, draw: ev.odds.draw, away: ev.odds.home }
                    : ev.odds;
                best = { score: m.score, odds };
            }
        }
        if (best) rows.push({ key, odds: best.odds });
    }
    return rows;
}

// From matched competitor rows, keep only the ones BwanaBet beats on total payout
// (strictly lower total). Not ranked — returned in the order given.
export function beatenBooks(bwanaOdds, rows) {
    const bwanaTotal = totalPayout(bwanaOdds);
    if (bwanaTotal == null) return [];
    return rows.filter(r => {
        const t = totalPayout(r.odds);
        return t != null && t < bwanaTotal - 1e-9;
    });
}
