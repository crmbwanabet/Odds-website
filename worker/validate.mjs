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
import { extractMarkets, OU_HANDICAP } from '../lib/markets.mjs';
import { multiQuery, getMainEvents, getEventDetail, findEventsByTeams, isToday } from '../lib/altenar.mjs';
import { rankBooks, buildMatchView } from '../lib/display.mjs';
import { handleV1 } from './v1.mjs';
import { readFileSync } from 'node:fs';

const FIXTURE_EVENT = () =>
    JSON.parse(readFileSync(new URL('../test/fixtures/altenar-event.json', import.meta.url)));

// `node worker/validate.mjs --offline` runs ONLY the deterministic checks. The
// live sections hit BwanaBet + the proxy, which is too slow and too flaky to sit
// inside a red-green-refactor loop. CI and pre-deploy runs use the full suite.
const OFFLINE = process.argv.includes('--offline');

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

// The local Altenar client that used to live here was deleted in favour of
// ../lib/altenar.mjs — the same module the Worker ships. Same reasoning as
// odds-match.mjs: one copy means these checks exercise the real client and it
// cannot silently drift from what production runs.
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

// ---------- 3. MARKET EXTRACTION ----------
function marketTests() {
    section('3. Market extraction');
    const ev = FIXTURE_EVENT();
    const markets = extractMarkets(ev.collections);
    const byCode = Object.fromEntries(markets.map(m => [m.marketCode, m]));

    check('returns exactly the five surfaced markets', markets.length === 5,
        'got ' + markets.map(m => m.marketCode).join(','));
    check('includes 1x2', !!byCode['1x2']);
    check('includes DC', !!byCode['DC']);
    check('includes BTS', !!byCode['BTS']);
    check('includes OE', !!byCode['OE']);
    check('includes OU_2.5', !!byCode['OU_2.5']);
    check('excludes To Qualify', !byCode['TQ']);
    check('excludes Draw No Bet', !byCode['DNB']);
    check('excludes team totals (IOU_T1)', !byCode['IOU_T1']);

    check('1x2 has three selections', byCode['1x2'].selections.length === 3);
    check('every selection carries a ref',
        markets.every(m => m.selections.every(s => typeof s.ref === 'string' && s.ref.length > 0)));
    check('every selection carries numeric odds',
        markets.every(m => m.selections.every(s => typeof s.odds === 'number' && s.odds > 0)));

    const ou = byCode['OU_2.5'];
    check('OU_2.5 has exactly two selections', ou.selections.length === 2);
    check('OU_2.5 takes the 2.5 line only',
        ou.selections.map(s => s.odds).sort().join(',') === '1.79,2.05');
    check('OU_2.5 labels include the line', ou.selections.some(s => s.label === 'Over 2.5'));
    check('OU_2.5 carries hcap', ou.selections.every(s => s.hcap === OU_HANDICAP));
    check('OU_2.5 comes from Goals, not Corners',
        ou.selections.every(s => s.ref.startsWith('43540311-6-')));
    check('main-collection selections have hcap 0',
        byCode['1x2'].selections.every(s => s.hcap === 0));

    // Blocked / zero-rate prices are dropped.
    const blocked = JSON.parse(JSON.stringify(ev.collections));
    blocked[0].markets[1].prices[0].blocked = true;
    blocked[0].markets[1].prices[1].rate = 0;
    const m2 = extractMarkets(blocked).find(m => m.marketCode === '1x2');
    check('drops blocked and zero-rate prices', m2.selections.length === 1);

    check('empty input returns empty array', extractMarkets(null).length === 0);
    check('missing Goals collection still returns main markets',
        extractMarkets([ev.collections[0]]).length === 4);
}

// ---------- 4. ALTENAR CLIENT (stubbed transport) ----------
async function altenarTests() {
    section('4. Altenar client (stubbed transport)');

    const okResponse = (data) => ({
        ok: true,
        json: async () => [{ error: false, message: 'Success', data }],
    });

    // multiQuery unwraps the [{ error, data }] envelope.
    let sentBody = null;
    const spyFetch = async (url, opts) => { sentBody = JSON.parse(opts.body); return okResponse({ hello: 'world' }); };
    const d0 = await multiQuery('mutation { x }', { fetchImpl: spyFetch });
    check('multiQuery unwraps data', d0 && d0.hello === 'world');
    check('multiQuery sends the graphs/makeQuery envelope',
        Array.isArray(sentBody) && sentBody[0].module === 'graphs' && sentBody[0].method === 'makeQuery');
    check('multiQuery passes the query through', sentBody[0].options.query === 'mutation { x }');

    // A non-ok HTTP response must throw, not return undefined.
    let threw = false;
    try { await multiQuery('mutation { x }', { fetchImpl: async () => ({ ok: false, status: 503 }) }); }
    catch { threw = true; }
    check('multiQuery throws on HTTP error', threw === true);

    // An error envelope must throw too.
    threw = false;
    try {
        await multiQuery('mutation { x }', {
            fetchImpl: async () => ({ ok: true, json: async () => [{ error: true, message: 'nope' }] }),
        });
    } catch { threw = true; }
    check('multiQuery throws on error envelope', threw === true);

    // getMainEvents flattens competitions into events carrying their competition.
    const feed = { mainEventList: [{ competitions: [
        { country: 'England', competitionName: 'Premier League', events: [
            { eventId: '1', eventName: 'Arsenal V Chelsea', eventStartTime: '2026-08-06T15:00:00.000Z', top: true },
            { eventId: '2', eventName: 'Everton V Fulham', eventStartTime: '2026-08-06T17:00:00.000Z', top: false },
        ] },
    ] }] };
    const feedFetch = { fetchImpl: async () => okResponse(feed) };
    const evs = await getMainEvents(1, feedFetch);
    check('getMainEvents flattens to 2 events', evs.length === 2);
    check('getMainEvents attaches competition', evs[0].competitionName === 'Premier League');
    check('getMainEvents attaches country', evs[0].country === 'England');
    check('getMainEvents preserves top flag', evs[0].top === true && evs[1].top === false);

    // getEventDetail returns the event AND its collections.
    const detail = { eventList: [{ competitions: [{ country: 'Europe', competitionName: 'UEFA Europa League', events: [
        { eventId: '43540311', eventName: 'KuPS V CS U Craiova', eventStartTime: '2026-08-06T15:00:00.000Z',
          collections: [{ collectionName: 'Main', markets: [] }] },
    ] }] }] };
    const d1 = await getEventDetail('43540311', { fetchImpl: async () => okResponse(detail) });
    check('getEventDetail returns the event', d1.event.eventId === '43540311');
    check('getEventDetail returns collections', Array.isArray(d1.collections) && d1.collections.length === 1);
    check('getEventDetail returns competition', d1.event.competitionName === 'UEFA Europa League');

    const d2 = await getEventDetail('999', { fetchImpl: async () => okResponse({ eventList: [] }) });
    check('getEventDetail returns null for a missing event', d2 === null);

    const d3 = await getEventDetail('not-a-number', { fetchImpl: async () => okResponse(detail) });
    check('getEventDetail returns null for a non-numeric id', d3 === null);

    // findEventsByTeams matches on both tokens for "A vs B".
    const m1 = await findEventsByTeams('arsenal vs chelsea', feedFetch);
    check('findEventsByTeams finds the fixture', m1.length === 1 && m1[0].eventId === '1');

    const m2 = await findEventsByTeams('everton', feedFetch);
    check('findEventsByTeams matches a single team', m2.length === 1 && m2[0].eventId === '2');

    const m3 = await findEventsByTeams('', feedFetch);
    check('findEventsByTeams returns [] for an empty query', m3.length === 0);

    const m4 = await findEventsByTeams('nothing here at all', feedFetch);
    check('findEventsByTeams returns [] when nothing matches', m4.length === 0);

    // isToday works in Africa/Lusaka (UTC+2, no DST).
    check('isToday true for same Lusaka day',
        isToday('2026-08-06T15:00:00.000Z', new Date('2026-08-06T06:00:00.000Z')) === true);
    check('isToday false for tomorrow',
        isToday('2026-08-07T15:00:00.000Z', new Date('2026-08-06T06:00:00.000Z')) === false);
    check('isToday handles the UTC+2 boundary (23:00Z is already tomorrow in Lusaka)',
        isToday('2026-08-06T23:00:00.000Z', new Date('2026-08-07T06:00:00.000Z')) === true);
}

// ---------- 5. DISPLAY ASSEMBLY ----------
function displayTests() {
    section('5. Display assembly');

    // rankBooks: BwanaBet plus beaten competitors, sorted by total payout desc.
    const bw = { home: '3.65', draw: '3.84', away: '2.04' };   // total 9.53
    const rows = [
        { key: 'sportybet', odds: { home: '3.62', draw: '3.79', away: '2.00' } },  // 9.41
        { key: 'bolabet', odds: { home: '3.55', draw: '3.70', away: '2.05' } },    // 9.30
    ];
    const ranked = rankBooks(bw, rows);
    check('ranked list is BwanaBet + competitors', ranked.length === 3);
    check('BwanaBet ranks first', ranked[0].book === 'bwanabet');
    check('BwanaBet is the only placeable row',
        ranked.filter(r => r.placeable).length === 1 && ranked[0].placeable === true);
    check('competitors sort by total payout desc',
        ranked[1].book === 'sportybet' && ranked[2].book === 'bolabet');
    check('rows carry display names', ranked[0].name === 'BwanaBet' && ranked[1].name === 'SportyBet');
    check('rows carry totals', Math.abs(ranked[0].total - 9.53) < 1e-9);
    check('rankBooks with no competitors returns just BwanaBet', rankBooks(bw, []).length === 1);

    // buildMatchView: full markets + comparison, wired to the real matcher.
    const ev = FIXTURE_EVENT();
    const index = buildIndex({
        sportybet: [{ home: 'KuPS', away: 'CS U Craiova', odds: { home: '3.70', draw: '3.30', away: '2.15' } }],
        betway: [{ home: 'Nowhere FC', away: 'Elsewhere United', odds: { home: '2.00', draw: '3.00', away: '4.00' } }],
    });
    const evMeta = {
        eventId: ev.eventId, eventName: ev.eventName, eventStartTime: ev.eventStartTime,
        competitionName: ev.competitionName, country: ev.country,
    };
    const view = buildMatchView({ event: evMeta, collections: ev.collections, competitorIndex: index });

    check('view carries the eventId', view.eventId === '43540311');
    check('view splits teams', view.homeTeam === 'KuPS' && view.awayTeam === 'CS U Craiova');
    check('view carries all five markets', view.markets.length === 5);
    check('view exposes 1x2 for comparison', view.odds1x2.home === '3.72');
    check('unmatched books are absent', !view.comparison.some(r => r.book === 'betway'));
    check('matched competitor appears', view.comparison.some(r => r.book === 'sportybet'));
    check('BwanaBet heads the comparison', view.comparison[0].book === 'bwanabet');
    check('competitor prices are capped below BwanaBet',
        view.comparison.slice(1).every(r =>
            ['home', 'draw', 'away'].every(k =>
                parseFloat(r.odds[k]) <= parseFloat(view.odds1x2[k]) - 0.03 + 1e-9)));
    check('comparisonAvailable is true when a book matched', view.comparisonAvailable === true);

    // No competitor data at all -> markets still returned, comparison just BwanaBet.
    const bare = buildMatchView({ event: evMeta, collections: ev.collections, competitorIndex: {} });
    check('no competitors still returns markets', bare.markets.length === 5);
    check('no competitors leaves BwanaBet alone in the ranking', bare.comparison.length === 1);
    check('comparisonAvailable is false with no matches', bare.comparisonAvailable === false);
}

// ---------- 6. /v1 ROUTER ----------
async function routerTests() {
    section('6. /v1 router');

    const ev = FIXTURE_EVENT();
    const deps = {
        getCompetitorIndex: async () => buildIndex({
            sportybet: [{ home: 'KuPS', away: 'CS U Craiova', odds: { home: '3.70', draw: '3.30', away: '2.15' } }],
        }),
        getEventDetail: async (id) => (String(id) === '43540311'
            ? { event: { eventId: ev.eventId, eventName: ev.eventName, eventStartTime: ev.eventStartTime,
                         competitionName: ev.competitionName, country: ev.country },
                collections: ev.collections }
            : null),
        findEventsByTeams: async (q) => (String(q).includes('kups')
            ? [{ eventId: '43540311', eventName: 'KuPS V CS U Craiova',
                 eventStartTime: ev.eventStartTime, competitionName: ev.competitionName, country: ev.country }]
            : []),
        getTodayEvents: async () => ([
            { eventId: '43540311', eventName: 'KuPS V CS U Craiova',
              eventStartTime: ev.eventStartTime, competitionName: ev.competitionName, country: ev.country },
        ]),
    };
    const call = (path, qs = '') => handleV1(path, new URLSearchParams(qs), deps);

    let r = await call('/v1/match/43540311');
    check('GET /v1/match/:id is 200', r.status === 200);
    check('match payload has markets', r.body.markets.length === 5);
    check('match payload has a ranked comparison', r.body.comparison[0].book === 'bwanabet');
    check('match payload exposes refs',
        r.body.markets.every(m => m.selections.every(s => !!s.ref)));

    r = await call('/v1/match/99999999');
    check('unknown event is 404', r.status === 404);
    check('unknown event has an error message', typeof r.body.error === 'string');

    r = await call('/v1/match/not-a-number');
    check('non-numeric event id is 400', r.status === 400);

    r = await call('/v1/matches', 'q=kups');
    check('GET /v1/matches?q= is 200', r.status === 200);
    check('search returns candidates', r.body.matches.length === 1);
    check('search results carry eventId + kickoff',
        !!r.body.matches[0].eventId && !!r.body.matches[0].kickoffUtc);
    check('search results do NOT carry odds (use /v1/match/:id)',
        r.body.matches[0].markets === undefined);

    r = await call('/v1/matches', 'q=');
    check('empty q is 400', r.status === 400);

    r = await call('/v1/matches', 'q=nothinghere');
    check('no results is still 200 with an empty list',
        r.status === 200 && r.body.matches.length === 0);

    r = await call('/v1/matches/today');
    check('GET /v1/matches/today is 200', r.status === 200);
    check('today returns the card', r.body.matches.length === 1);

    r = await call('/v1/nonsense');
    check('unknown /v1 route is 404', r.status === 404);

    // A competitor-feed outage must degrade, not fail the fixture.
    const broken = { ...deps, getCompetitorIndex: async () => { throw new Error('proxy down'); } };
    r = await handleV1('/v1/match/43540311', new URLSearchParams(''), broken);
    check('competitor outage still returns 200', r.status === 200);
    check('competitor outage still returns markets', r.body.markets.length === 5);
    check('competitor outage leaves comparison unavailable', r.body.comparisonAvailable === false);
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
    marketTests();
    await altenarTests();
    displayTests();
    await routerTests();
    if (!OFFLINE) await liveChecks();
    console.log(`\n${failed === 0 ? '✅ PASS' : '❌ FAIL'} — ${passed} passed, ${failed} failed`);
    if (failed) { console.log('failed:'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
})();
