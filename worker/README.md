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
| Gal Sport  | ⛔ n/a  | BetConstruct **WebSocket** + Cloudflare challenge — not a simple relay; needs a headless scraper |
| BolaBet    | ⛔ n/a  | ASMX + SignalR streams — not a simple relay; needs a headless scraper |
| Mojabet    | ⛔ n/a  | DataDome bot protection + opaque widget feed — server-side relay would be blocked/brittle |
| Castle Bet | ⛔ n/a  | Cloudflare-challenged (403 to non-browser clients) |

## Files

- `adapters.mjs` — the per-book fetch + normalize logic (shared).
- `odds-proxy.js` — Cloudflare Worker entry (imports adapters).
- `dev-server.mjs` — local Node server running the *same* adapters, for testing.
- `wrangler.toml` — Worker deploy config.

## Local testing

```bash
node worker/dev-server.mjs          # serves http://localhost:8787/odds
```
Keep `CONFIG.PROXY_URL = 'http://localhost:8787'` in `../index.html`, open the site,
click **Compare other bookmakers** on any match.

## Production deploy (free)

```bash
npm i -g wrangler
wrangler login
cd worker
wrangler deploy
```
Wrangler prints a URL like `https://oddszone-odds-proxy.<subdomain>.workers.dev`.
Put that into `CONFIG.PROXY_URL` in `../index.html` and redeploy the site.

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
