/**
 * Traffic / load check for the competitor-odds proxy.
 *
 *   node worker/loadtest.mjs [totalRequests] [concurrency]
 *   node worker/loadtest.mjs 200 40
 *
 * The proxy is the only piece of our infrastructure in the hot path (the static
 * site is CDN-served HTML; BwanaBet's Altenar feed is BwanaBet's own infra and is
 * deliberately NOT hammered here). This measures that the proxy:
 *   - stays fast and correct under concurrent load,
 *   - actually serves from its ~45s cache instead of re-fanning-out to the 5
 *     bookmaker feeds on every request (verified via a stable `updatedAt`),
 *   - returns well-formed, non-empty data every time.
 *
 * Modest defaults so we don't behave abusively toward the upstream books.
 */
const PROXY_URL = process.env.PROXY_URL || 'https://oddszone-odds-proxy.oddszone.workers.dev';
const TOTAL = Number(process.argv[2] || 150);
const CONCURRENCY = Number(process.argv[3] || 30);

function now() { return Number(process.hrtime.bigint() / 1000000n); }

async function oneRequest() {
    const t0 = now();
    try {
        const res = await fetch(`${PROXY_URL}/odds`, { headers: { 'Accept': 'application/json' } });
        const body = await res.json();
        const ms = now() - t0;
        const books = body.books || {};
        const events = Object.values(books).reduce((n, a) => n + (a?.length || 0), 0);
        const ok = res.ok && events > 0 && typeof body.updatedAt === 'string';
        return { ms, ok, status: res.status, updatedAt: body.updatedAt, events, cf: res.headers.get('cf-cache-status') };
    } catch (e) {
        return { ms: now() - t0, ok: false, status: 0, error: e.message };
    }
}

async function run() {
    console.log(`Load test → ${PROXY_URL}/odds`);
    console.log(`${TOTAL} requests, ${CONCURRENCY} concurrent\n`);

    const results = [];
    let launched = 0;
    const wallStart = now();

    async function worker() {
        while (launched < TOTAL) {
            launched++;
            results.push(await oneRequest());
        }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    const wall = now() - wallStart;
    const oks = results.filter(r => r.ok);
    const lat = oks.map(r => r.ms).sort((a, b) => a - b);
    const pct = p => lat.length ? lat[Math.min(lat.length - 1, Math.floor(p / 100 * lat.length))] : NaN;
    const updatedAts = new Set(oks.map(r => r.updatedAt));
    const cfStatuses = {};
    for (const r of oks) { const k = r.cf || 'none'; cfStatuses[k] = (cfStatuses[k] || 0) + 1; }

    console.log(`success:      ${oks.length}/${results.length}`);
    console.log(`throughput:   ${(results.length / (wall / 1000)).toFixed(1)} req/s (wall ${(wall / 1000).toFixed(2)}s)`);
    console.log(`latency ms:   min ${lat[0]}  p50 ${pct(50)}  p90 ${pct(90)}  p99 ${pct(99)}  max ${lat[lat.length - 1]}`);
    console.log(`distinct updatedAt values: ${updatedAts.size}  ${updatedAts.size <= 3 ? '(cache serving — upstream books not re-fetched per request)' : '(⚠ many refreshes)'}`);
    console.log(`event counts seen: ${new Set(oks.map(r => r.events)).size} distinct`);
    console.log(`cf-cache-status: ${JSON.stringify(cfStatuses)}`);

    const failures = results.filter(r => !r.ok);
    if (failures.length) {
        console.log(`\n⚠ ${failures.length} failures:`);
        const byStatus = {};
        for (const f of failures) { const k = f.status + (f.error ? ':' + f.error : ''); byStatus[k] = (byStatus[k] || 0) + 1; }
        console.log('  ' + JSON.stringify(byStatus));
    }

    // Verdict: every request succeeded, and the cache kept upstream fan-out bounded.
    const pass = oks.length === results.length && updatedAts.size <= 3;
    console.log(`\n${pass ? '✅ PASS' : '❌ CHECK'} — ${oks.length}/${results.length} ok, ${updatedAts.size} cache generation(s) over the run`);
    process.exit(pass ? 0 : 1);
}

run();
