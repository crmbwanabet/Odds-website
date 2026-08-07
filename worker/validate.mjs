/**
 * Accuracy harness for the odds-comparison logic.
 *
 *   node worker/validate.mjs
 *
 * It imports the SAME lib/odds-match.mjs the website ships, so every check here is
 * run against the real matcher — not a copy that could drift. Two layers:
 *
 *   1. Offline unit tests — deterministic checks of normalization + fuzzy matching,
 *      including the abbreviation cases the prefix rule is meant to recover and the
 *      false-positive cases it must still reject.
 *   2. Live invariant checks — pull real BwanaBet + competitor odds and assert the
 *      site's guarantees hold on today's fixtures: the "beats" list only ever
 *      contains books with a strictly lower total payout, matching is deterministic,
 *      and every surfaced match is a genuine same-fixture pairing (no prefix noise).
 *
 * Exits non-zero if any check fails, so it can gate a deploy.
 */
import {
    normTeam, tokensMatch, tokenOverlap, isSameFixture, MATCH_THRESHOLD,
    totalPayout, buildIndex, matchCompetitors, beatenBooks, extract1x2, splitTeams
} from '../lib/odds-match.mjs';
import { BOOK_NAMES, COMP_KEYS as REGISTRY_COMP_KEYS, bookName } from '../lib/books.mjs';

// `node worker/validate.mjs --offline` runs ONLY the deterministic checks. The
// live sections hit BwanaBet + the proxy, which is too slow and too flaky to sit
// inside a red-green-refactor loop. CI and pre-deploy runs use the full suite.
const OFFLINE = process.argv.includes('--offline');

const ALTENAR_API = 'https://api.bwanabet.co.zm/api/v2/multi';
const PROXY_URL = process.env.PROXY_URL || 'https://oddszone-odds-proxy.oddszone.workers.dev';
const SPORT_FOOTBALL = 501;
const COMP_KEYS = ['sportybet', 'onexbet', 'betway', 'betpawa', 'bolabet'];

// ---------- tiny test harness ----------
let passed = 0, failed = 0;
const fails = [];
function check(name, cond, detail) {
    if (cond) { passed++; }
    else { failed++; fails.push(name + (detail ? ` — ${detail}` : '')); console.log('  ✗ ' + name + (detail ? ` — ${detail}` : '')); }
}
function section(t) { console.log('\n' + t); }

// ---------- 1. OFFLINE UNIT TESTS ----------
function unitTests() {
    section('1. Offline unit tests (matcher)');

    // token-level prefix rule: recover truncations, reject short/noise collisions.
    check('tokensMatch brat⊂bratislava', tokensMatch('brat', 'bratislava') === true);
    check('tokensMatch wolver⊂wolverhampton', tokensMatch('wolver', 'wolverhampton') === true);
    check('tokensMatch exact equal', tokensMatch('arsenal', 'arsenal') === true);
    check('tokensMatch st⊄stuttgart (too short)', tokensMatch('st', 'stuttgart') === false);
    check('tokensMatch san⊄santos (too short, 3 chars)', tokensMatch('san', 'santos') === false);
    check('tokensMatch real⊄madrid (unrelated)', tokensMatch('real', 'madrid') === false);
    check('tokensMatch inter partial not substring', tokensMatch('inter', 'milan') === false);

    // normTeam drops stopwords/accents, applies aliases.
    check('normTeam strips FC + accents', setEq(normTeam('FC Ararat-Armenia'), new Set(['ararat', 'armenia'])));
    check('normTeam Man Utd → manchester united(stop)+', setEq(normTeam('Man Utd'), new Set(['manchester'])));
    check('normTeam keeps year token', setEq(normTeam('FC Iberia 1999'), new Set(['iberia', '1999'])));

    // The BolaBet regression: abbreviated away team must now match.
    const card = { home: normTeam('FC Iberia 1999'), away: normTeam('SK Slovan Bratislava') };
    const bola = { norm: { home: normTeam('Iberia 1999'), away: normTeam('Slovan Brat.') } };
    check('overlap Slovan Bratislava vs Slovan Brat. = 1.0', tokenOverlap(card.away, bola.norm.away) === 1);
    check('isSameFixture matches BolaBet abbreviation', isSameFixture(card, bola).score >= MATCH_THRESHOLD,
        'score=' + isSameFixture(card, bola).score.toFixed(2));

    // False-positive guards: different fixtures must NOT confirm, even when one token
    // collides by prefix.
    const bayer = { home: normTeam('Bayer Leverkusen'), away: normTeam('RB Leipzig') };
    const bayern = { norm: { home: normTeam('Bayern Munich'), away: normTeam('SC Freiburg') } };
    check('Bayer Leverkusen ≠ Bayern Munich fixture', isSameFixture(bayer, bayern).score < MATCH_THRESHOLD,
        'score=' + isSameFixture(bayer, bayern).score.toFixed(2));

    const realM = { home: normTeam('Real Madrid'), away: normTeam('Getafe') };
    const realS = { norm: { home: normTeam('Real Sociedad'), away: normTeam('Osasuna') } };
    check('Real Madrid ≠ Real Sociedad fixture', isSameFixture(realM, realS).score < MATCH_THRESHOLD,
        'score=' + isSameFixture(realM, realS).score.toFixed(2));

    // home/away swap detection.
    const cA = { home: normTeam('Arsenal'), away: normTeam('Chelsea') };
    const evSwapped = { norm: { home: normTeam('Chelsea'), away: normTeam('Arsenal') } };
    const m = isSameFixture(cA, evSwapped);
    check('swap detected', m.score >= MATCH_THRESHOLD && m.swapped === true);

    // totalPayout + beatenBooks math.
    check('totalPayout sums', totalPayout({ home: '2.10', draw: '3.40', away: '3.80' }).toFixed(2) === '9.30');
    check('totalPayout null on suspended', totalPayout({ home: '-', draw: '3.4', away: '2.0' }) === null);
    const bwana = { home: '3.65', draw: '3.84', away: '2.04' }; // 9.53
    const rows = [
        { key: 'sportybet', odds: { home: '3.62', draw: '3.79', away: '2.00' } }, // 9.41 beaten
        { key: 'betway', odds: { home: '3.75', draw: '4.00', away: '1.80' } },    // 9.55 NOT beaten
        { key: 'bolabet', odds: { home: '3.55', draw: '3.70', away: '2.05' } },   // 9.30 beaten
    ];
    const beaten = beatenBooks(bwana, rows).map(r => r.key);
    check('beatenBooks keeps strictly-lower totals', setEq(new Set(beaten), new Set(['sportybet', 'bolabet'])),
        'got ' + JSON.stringify(beaten));
    check('beatenBooks excludes higher total (safety)', !beaten.includes('betway'));
    check('beatenBooks empty when BwanaBet suspended',
        beatenBooks({ home: '-', draw: '3.4', away: '2.0' }, rows).length === 0);
}

function setEq(a, b) {
    if (a.size !== b.size) return false;
    for (const x of a) if (!b.has(x)) return false;
    return true;
}

// ---------- BwanaBet (Altenar) minimal client ----------
async function multiQuery(query) {
    const res = await fetch(ALTENAR_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([{ module: 'graphs', method: 'makeQuery', options: { query } }]),
    });
    if (!res.ok) throw new Error('Altenar ' + res.status);
    const data = await res.json();
    if (!Array.isArray(data) || !data[0] || data[0].error) throw new Error('Altenar bad response');
    return data[0].data;
}
async function getTopBwanaEvents(limit = 12) {
    const out = [];
    const seen = new Set();
    for (let page = 1; page <= 4 && out.length < limit; page++) {
        const q = `mutation { mainEventList(mainEventListInput: { topEvents: false page: ${page} sportId: ${SPORT_FOOTBALL} limit: 100 }) { competitions { competitionName country events { eventId eventName top } } } }`;
        const data = await multiQuery(q);
        const sport = data.mainEventList && data.mainEventList[0];
        if (!sport) break;
        for (const comp of sport.competitions || []) {
            for (const e of comp.events || []) {
                if (!seen.has(e.eventId)) { seen.add(e.eventId); out.push({ ...e, competitionName: comp.competitionName, country: comp.country }); }
            }
        }
    }
    // prefer curated "top" events, then just the first ones.
    return out.sort((a, b) => (b.top === true) - (a.top === true)).slice(0, limit);
}
// Altenar's endpoint is not flexible GraphQL — it 500s unless the full field set is
// present, so this mirrors the site's getEventCollections query exactly, then decodes
// with the shared extract1x2.
async function getBwanaOdds(eventId) {
    const q = `mutation {
        eventList(eventListInput: { eventId: ${Number(eventId)} }) {
            sportId
            competitions {
                competitionId country competitionName
                events {
                    eventId eventName eventStartTime
                    collections {
                        collectionId collectionName
                        markets {
                            marketId marketName marketCode
                            prices { referenceId priceName handicapValue rate blocked }
                        }
                    }
                }
            }
        }
    }`;
    const data = await multiQuery(q);
    const collections = data.eventList?.[0]?.competitions?.[0]?.events?.[0]?.collections || null;
    return extract1x2(collections);
}

// find the specific competitor event a card matched, for the false-positive audit.
function matchedEvent(homeTeam, awayTeam, events) {
    const cardNorm = { home: normTeam(homeTeam), away: normTeam(awayTeam) };
    let best = null;
    for (const ev of events) {
        const m = isSameFixture(cardNorm, ev);
        if (m.score >= MATCH_THRESHOLD && (!best || m.score > best.m.score)) best = { ev, m };
    }
    return best;
}

// ---------- 2. LIVE INVARIANT CHECKS ----------
async function liveChecks() {
    section('7. Live invariant checks (real fixtures)');

    let books, cards;
    try {
        const [proxyRes, events] = await Promise.all([
            fetch(`${PROXY_URL}/odds`).then(r => r.json()),
            getTopBwanaEvents(12),
        ]);
        books = proxyRes.books || {};
        const withOdds = [];
        for (const e of events) {
            const odds = await getBwanaOdds(e.eventId);
            if (odds && totalPayout(odds) != null) {
                const { home, away } = splitTeams(e.eventName);
                withOdds.push({ homeTeam: home, awayTeam: away || 'TBA', odds });
            }
            if (withOdds.length >= 10) break;
        }
        cards = withOdds;
    } catch (e) {
        console.log('  ⚠ could not load live data (' + e.message + ') — skipping live checks (offline still gate).');
        return;
    }

    const index = buildIndex(books);
    const totalEvents = Object.values(books).reduce((n, a) => n + a.length, 0);
    console.log(`  data: ${cards.length} BwanaBet cards, ${totalEvents} competitor events across ${Object.keys(books).length} books`);
    check('proxy returned competitor data', totalEvents > 0);
    check('got BwanaBet cards to test', cards.length > 0);

    // determinism: identical output on a second pass.
    let deterministic = true;
    for (const c of cards) {
        const a = JSON.stringify(matchCompetitors(c.homeTeam, c.awayTeam, index, COMP_KEYS));
        const b = JSON.stringify(matchCompetitors(c.homeTeam, c.awayTeam, index, COMP_KEYS));
        if (a !== b) deterministic = false;
    }
    check('matching is deterministic', deterministic);

    let totalMatches = 0, totalBeaten = 0, safetyViolations = 0, fixtureViolations = 0, oddsViolations = 0;
    const examples = [];
    for (const card of cards) {
        const bwanaTotal = totalPayout(card.odds);
        const rows = matchCompetitors(card.homeTeam, card.awayTeam, index, COMP_KEYS);
        totalMatches += rows.length;
        const beaten = beatenBooks(card.odds, rows);
        totalBeaten += beaten.length;

        // SAFETY: nothing shown may beat or tie BwanaBet.
        for (const r of beaten) {
            const t = totalPayout(r.odds);
            if (!(t < bwanaTotal - 1e-9)) safetyViolations++;
            // odds must be real decimal prices.
            if (!['home', 'draw', 'away'].every(k => Number(r.odds[k]) > 1.0)) oddsViolations++;
        }

        // GENUINE MATCH: re-audit each matched book is truly the same fixture and the
        // raw names share a real (>=4-char) token — guards against prefix over-match.
        for (const r of rows) {
            const me = matchedEvent(card.homeTeam, card.awayTeam, index[r.key] || []);
            if (!me) { fixtureViolations++; continue; }
            if (!sharesRealToken(card, me.ev)) {
                fixtureViolations++;
                console.log(`  ✗ suspicious match [${r.key}]: "${card.homeTeam} v ${card.awayTeam}" ⟷ "${me.ev.home} v ${me.ev.away}"`);
            }
        }

        if (beaten.length && examples.length < 4) {
            examples.push(`    ${card.homeTeam} v ${card.awayTeam} (${bwanaTotal.toFixed(2)}) beats: ` +
                beaten.map(r => `${r.key} ${totalPayout(r.odds).toFixed(2)}`).join(', '));
        }
    }

    console.log(`  matched ${totalMatches} competitor rows; ${totalBeaten} shown as beaten`);
    if (examples.length) { console.log('  examples:'); examples.forEach(e => console.log(e)); }
    check('SAFETY: no shown book beats/ties BwanaBet', safetyViolations === 0, safetyViolations + ' violations');
    check('all shown odds are valid decimals > 1.0', oddsViolations === 0, oddsViolations + ' bad rows');
    check('all matches are genuine same-fixture pairs', fixtureViolations === 0, fixtureViolations + ' suspicious');
}

// ---------- 2. BOOK REGISTRY ----------
function bookRegistryTests() {
    section('2. Book registry');
    check('COMP_KEYS has the five competitors',
        REGISTRY_COMP_KEYS.length === 5 && REGISTRY_COMP_KEYS.includes('sportybet'));
    check('bwanabet is NOT a competitor', REGISTRY_COMP_KEYS.includes('bwanabet') === false);
    check('bookName maps keys to display names', bookName('onexbet') === '1xBet');
    check('bookName falls back to the key', bookName('unknownbook') === 'unknownbook');
    check('every competitor key has a name',
        REGISTRY_COMP_KEYS.every(k => typeof BOOK_NAMES[k] === 'string' && BOOK_NAMES[k].length > 0));
    // The registry must stay in step with the proxy's own book list.
    check('registry matches the harness COMP_KEYS',
        REGISTRY_COMP_KEYS.slice().sort().join(',') === COMP_KEYS.slice().sort().join(','));
}

// Do the card and matched event share at least one real 4+ char token (either side,
// allowing swap)? A pure prefix-noise match would fail this.
function sharesRealToken(cardNorm, ev) {
    const cn = { home: normTeam(cardNorm.homeTeam), away: normTeam(cardNorm.awayTeam) };
    const big = new Set([...ev.norm.home, ...ev.norm.away]);
    for (const t of new Set([...cn.home, ...cn.away])) {
        if (t.length >= 4 && big.has(t)) return true;
    }
    return false;
}

// ---------- run ----------
(async () => {
    console.log('OddsZone accuracy validation' + (OFFLINE ? ' (offline)' : ''));
    unitTests();
    bookRegistryTests();
    if (!OFFLINE) await liveChecks();
    console.log(`\n${failed === 0 ? '✅ PASS' : '❌ FAIL'} — ${passed} passed, ${failed} failed`);
    if (failed) { console.log('failed:'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
})();
