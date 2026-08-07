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
- `v1.mjs` — `/v1` routes for the AI Betting Assistant (transport-free handler).
- `../lib/altenar.mjs` — server-side BwanaBet client (the only file that talks to Altenar).
- `../lib/markets.mjs` — full BwanaBet market extraction, with referenceIds.
- `../lib/display.mjs` — assembles the fixture view the API returns.
- `../lib/books.mjs` — bookmaker key/name registry.

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

## `/v1` — the AI Betting Assistant API

The assistant is not allowed to read a bookmaker feed. It reads **the odds this
site displays**, after matching, capping (`capOddsAgainstBwana`) and filtering
(`beatenBooks`). These endpoints are that display output over HTTP.

### `GET /v1/matches?q=<team or fixture>`

Candidate fixtures for a name. No odds — resolving prices for every candidate
would cost one Altenar call per result on what is usually just disambiguation.

```json
{ "query": "arsenal",
  "matches": [ { "eventId": "43540311", "eventName": "Arsenal V Chelsea",
                 "competition": "Premier League", "country": "England",
                 "kickoffUtc": "2026-08-06T15:00:00.000Z" } ] }
```

`400` if `q` is empty. An empty `matches` array is a normal `200`.

Matching is plain substring over the first pages of the feed, inherited from
`index.html`. `q=arsenal` returns *Arsenal Dzerzhinsk* and *Arsenal Tivat*
alongside (or instead of) Arsenal FC — callers must disambiguate.

### `GET /v1/matches/today`

Today's card, where "today" is the calendar day in Lusaka (UTC+2, no DST) — not
UTC. Same row shape as above.

### `GET /v1/match/:eventId`

One fixture, in full.

```json
{ "eventId": "43705463", "eventName": "Surkhon V Navbahor Namangan",
  "homeTeam": "Surkhon", "awayTeam": "Navbahor Namangan",
  "competition": "Super League", "country": "Uzbekistan",
  "kickoffUtc": "2026-08-07T14:00:00.000Z",
  "markets": [
    { "marketCode": "1x2", "marketName": "Match Result",
      "selections": [ { "label": "1", "odds": 6.71,
                        "ref": "43705463-1-6992-0.00", "hcap": 0 } ] }
  ],
  "odds1x2": { "home": "6.71", "draw": "4.55", "away": "1.41" },
  "comparison": [
    { "book": "bwanabet", "name": "BwanaBet", "odds": { "...": "..." },
      "total": 12.67, "placeable": true },
    { "book": "betpawa", "name": "BetPawa", "odds": { "...": "..." },
      "total": 12.38, "placeable": false }
  ],
  "comparisonAvailable": true }
```

`400` for a non-numeric id, `404` if the event is unknown, `502` if Altenar is
unreachable.

**Markets surfaced:** `1x2`, `DC`, `BTS`, `OE` (from the `Main` collection) and
`OU_2.5` (the 2.5 line of the `OU` market in the `Goals` collection). Everything
else Altenar returns is dropped. Note that `OU` also appears in `Corners`, and
`Goals` also holds per-team totals (`IOU_T1`/`IOU_T2`) with their own 2.5 line —
extraction is scoped to the `Goals` collection's `OU` market specifically.

**`ref` is load-bearing.** It is the Altenar `referenceId`, and it is what
BwanaBet's share-code endpoint needs to build a placeable slip. A selection
without one cannot be bet.

**`comparisonAvailable: false` is normal, not an error.** `beatenBooks()` returns
empty whenever BwanaBet does not win on total payout, which is a routine outcome.
Consumers must render it as "no comparison for this fixture".

**`comparison` is always headed by BwanaBet** and BwanaBet is the only row with
`placeable: true` — every competitor price has already been capped at
`bwanabet − 0.03` upstream.

A competitor-feed outage degrades rather than fails: `/v1/match/:id` still
returns BwanaBet's markets, with an empty comparison. An **Altenar** timeout does
not degrade — it returns `502`. This is most likely on a cold isolate, where the
parallel competitor fan-out contends with the Altenar fetch.

### Parity

`validate.mjs` section 8 rebuilds a live fixture locally the way the site does it
and asserts the API agrees. Run it against any deployment:

```bash
V1_URL=https://oddszone-odds-proxy.oddszone.workers.dev node worker/validate.mjs
node worker/validate.mjs --offline    # deterministic checks only, no network
```
