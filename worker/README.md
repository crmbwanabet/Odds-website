# OddsZone competitor-odds proxy

The website reads **BwanaBet** odds directly (its Altenar feed is CORS-open). Every
other Zambian bookmaker's feed is **CORS-locked**, so a browser on the static site
cannot read it. This tiny proxy fetches those feeds *server-to-server* (where CORS
doesn't apply) and re-serves them **with** a CORS header so the site can consume them.

It invents nothing. Every price it returns is the bookmaker's own live 1X2
(home/draw/away) coefficient, decoded from that bookmaker's own website feed. A book
that can't be fetched is simply omitted — never faked.

## Books covered

| Book       | Status | How |
|------------|--------|-----|
| SportyBet  | ✅ live | Public JSON `factsCenter/pcUpcomingEvents` |
| 1xBet      | ✅ live | Public JSON `LineFeed/Get1x2_VZip` |
| Betway     | ✅ live | Public JSON `BetBook/Highlights` (esports/virtual rows self-filter — they never match a real fixture) |
| BetPawa    | ✅ live | JSON via `sportsbook/v4/events/lists/by-queries` (`Accept: application/json` content-negotiates away the protobuf; prices explicitly labelled 1/X/2, verified against the live site) |
| BolaBet    | ✅ live | ASMX JSON POST `ControlsWS.asmx/TopLeagues` (the SignalR streams only push *live* in-play updates; pre-match odds are a plain cookieless POST). Prices labelled 1/X/2, times are UTC+2, verified against the live site |
| Gal Sport  | ⛔ geo  | Endpoint is actually plain JSON (`services/evapi/event/GetEvents?sportTypeIds=31`), **not** a WebSocket — but `gsb.co.zm` is **geo-blocked to Zambian IPs behind a Cloudflare challenge**. The Worker (non-ZM IP) gets the block page. Needs a relay hosted on a Zambian IP + CF-challenge pass, not a simple Worker fetch |
| Mojabet    | ⛔ n/a  | DataDome bot protection + opaque widget feed — server-side relay would be blocked/brittle |
| Castle Bet | ⛔ n/a  | Cloudflare-challenged (403 to non-browser clients) |

## Files

- `adapters.mjs` — the per-book fetch + normalize logic (shared).
- `odds-proxy.js` — Cloudflare Worker entry (imports adapters).
- `dev-server.mjs` — local Node server running the *same* adapters, for testing.
- `wrangler.toml` — Worker deploy config.
- `validate.mjs` — accuracy harness (unit tests + live invariant checks). See below.
- `loadtest.mjs` — proxy load / cache-behaviour check.
- `../lib/odds-match.mjs` — the fixture-matching + odds math shared by the site
  (`index.html`) and `validate.mjs`, so tests exercise the real matcher.

## Fixture matching (`lib/odds-match.mjs`)

Books spell teams differently, so a competitor is paired to a BwanaBet card by
token overlap on normalized names. Tokens match when equal **or** one is a ≥4-char
prefix of the other (recovers truncations like "Slovan **Brat.**" ↔ "Slovan
Bratislava"). A fixture is only confirmed when **both** sides clear 0.7 overlap, so
a single stray prefix collision can never confirm a wrong match.

## Caching / traffic

The proxy is the only OddsZone-owned service in the hot path. It caches in three
layers so a spike never re-fetches the 5 bookmaker feeds more than necessary:

1. **In-isolate memory** (~45s) — instant, private to one Worker isolate.
2. **Cloudflare Cache API** — shared across isolates in a datacenter, so a burst of
   cold isolates does ~one upstream fan-out per colo per TTL, not one per request.
3. **Live fan-out** — concurrent misses in an isolate are coalesced into a single
   in-flight fetch.

## Local testing

```bash
node worker/dev-server.mjs          # serves http://localhost:8787/odds
node worker/validate.mjs            # unit tests + live accuracy checks (exit≠0 on fail)
node worker/loadtest.mjs 150 30     # 150 requests, 30 concurrent
```
For UI testing set `CONFIG.PROXY_URL = 'http://localhost:8787'` in `../index.html`,
serve the site over http (it now loads `./lib/odds-match.mjs` as an ES module, which
does not work from `file://`), open a match, and check the odds list.

## Production deploy (free)

```bash
npm i -g wrangler
wrangler login
cd worker
wrangler deploy
```
Wrangler prints a URL like `https://oddszone-odds-proxy.<subdomain>.workers.dev`.
Put that into `CONFIG.PROXY_URL` in `../index.html` and redeploy the site.

**Deploying the site:** `index.html` now imports `./lib/odds-match.mjs`, so the
deploy must include the `lib/` folder and the host must serve `.mjs` as JavaScript
(Cloudflare Pages, Netlify, Vercel, and GitHub Pages all do). Keep `index.html` and
`lib/` at the same relative path.

## Response shape

```
GET /odds
{
  "updatedAt": "2026-07-20T12:46:10.072Z",
  "books": {
    "sportybet": [ { "home": "Kalmar FF", "away": "Malmo FF", "start": "...", "odds": { "home": "2.72", "draw": "3.55", "away": "2.44" } }, ... ],
    "onexbet":   [ ... ],
    "betway":    [ ... ]
  }
}
```
Optional `?book=betway` filters to one book. Results are cached ~45s server-side.
