# 🏮 Night Market

**▶ Play now: https://night-market.inunanba.deno.net** · API docs: https://night-market.inunanba.deno.net/api

**A sealed-bid lantern auction for 2–4 players: humans in the browser, agents over HTTP/JSON.**
You get one 15-coin purse for the whole night. Eight stalls open, one at a time, and everyone bids in secret. If the top bids tie, **those coins burn** and the stall drops to the next bidder down, so a bid of 0 can win the best stall in the market.

- No install, no login. Open the URL and press **Play now vs bots**, or open a lobby and share its 4-letter code.
- Bots fill any empty seat. There are four personalities: Tanuki Tom, Vixen Vee, Miser Moth and Night Owl.
- Every bid is flipped at once in a reveal animation, and finished matches get a full replay and a shareable link.
- The agent API has 8 endpoints, but a bot only needs 3 (quickplay, bid, state). It uses long-polling (no tight loops) and returns plain JSON errors. Sample bots are in Python (stdlib only) and JS.

## Rules
| | |
|---|---|
| Rounds | 8 stalls. You always see the *next* stall coming. |
| Purse | 15 coins for the whole game. Bid any integer from 0 to your coins. |
| Win | Highest bid wins the stall and pays it. Losers pay nothing. |
| 🔥 Burn | Players tied for the top bid all pay and get nothing. The stall goes to the next-highest untied bid. If everyone ties, nobody gets it. |
| Score | stall points + **4** per colour with 3+ stalls + **5** for owning all 4 colours (red/gold/jade/indigo) + **1 per 3 leftover coins** |
| Mystery | 🔮📦🎭🏮 stalls hide their value (−2, 1, 5 or 7) until sold. |
| Clock | 60 s per round by default (5–300 configurable). A player who misses the deadline passes with a bid of 0. |

## Agent API
Base URL: `https://night-market.inunanba.deno.net`. All bodies are JSON. Auth uses the player token you get back from create, join or quickplay, sent as `Authorization: Bearer <token>` (or `?token=`). `GET /api` returns these docs as JSON.

| Method | Path | Body → Result |
|---|---|---|
| POST | `/api/quickplay` | `{name?, seats?:2-4, turnSeconds?}` → `{code, token, playerId, state}`. The match is already started, with bots in the other seats. |
| POST | `/api/matches` | `{name?, seats?, turnSeconds?, bots?}` → lobby `{code, token, playerId, joinUrl, state}` |
| POST | `/api/matches/{code}/join` | `{name?}` → `{token, playerId, state}`. The match auto-starts when full. |
| POST | `/api/matches/{code}/start` | host only. Fills empty seats with bots and starts. |
| GET | `/api/matches/{code}?since={version}` | state. With `since`, the request **long-polls up to 25 s** and returns as soon as anything changes. |
| POST | `/api/matches/{code}/bid` | `{bid}` → state |
| GET | `/api/matches/{code}/log` | full history plus the deck (after the game), for replays |
| GET | `/api/rules` | rules as JSON |

The fields you need from `state`: `status` (`lobby|playing|done`), `version`, `round`, `stall {name, colour, points|null, mystery}`, `nextStall`, `secondsLeft`, `players[] {id, name, coins, stalls, hasBid}`, `history[]` (every revealed bid), `final[]`, and `you {id, coins, mustBid, legalBids:{min,max}}`.

Errors look like `{"error":"bad_bid","message":"Bid must be an integer from 0 to 7"}`, with HTTP 400, 401, 404, 409, 410 or 429.

### Copy-paste: a complete game from bash (needs `curl` + `jq`)
```bash
URL=https://night-market.inunanba.deno.net
J=$(curl -s -XPOST $URL/api/quickplay -H 'content-type: application/json' -d '{"name":"curl-bot"}')
CODE=$(jq -r .code <<<"$J"); TOKEN=$(jq -r .token <<<"$J"); S=$(jq .state <<<"$J")
echo "match $CODE  (watch it: $URL/#$CODE)"
while [ "$(jq -r .status <<<"$S")" != done ]; do
  if [ "$(jq -r .you.mustBid <<<"$S")" = true ]; then
    BID=$(jq '[.you.coins, ((.stall.points // 3) + 1)] | min' <<<"$S")   # naive: points+1
    echo "round $(jq .round <<<"$S"): $(jq -r .stall.name <<<"$S") -> bid $BID"
    S=$(curl -s -XPOST $URL/api/matches/$CODE/bid -H "authorization: Bearer $TOKEN" -d "{\"bid\":$BID}")
  else   # long-poll: returns as soon as something changes (max 25 s)
    S=$(curl -s "$URL/api/matches/$CODE?since=$(jq .version <<<"$S")" -H "authorization: Bearer $TOKEN")
  fi
done
jq -r '.final[] | "#\(.rank) \(.name): \(.total) pts"' <<<"$S"
```
Pseudocode for any language:
```
state = POST /api/quickplay
while state.status != "done":
    if state.you.mustBid: state = POST /api/matches/{code}/bid {bid}
    else:                 state = GET  /api/matches/{code}?since={state.version}
```
Sample bots: [`bots/sample_bot.py`](bots/sample_bot.py) (`python3 bots/sample_bot.py https://<url> [CODE]`) and [`bots/sample_bot.mjs`](bots/sample_bot.mjs). Both are also served at `/bots/…`.

## Run locally
```bash
deno task start      # http://localhost:8000  (Deno 2, uses Deno KV)
deno task test       # rules, API, timeouts, long-poll, 30 concurrent lobbies
```

## Design notes
- **Stateless servers, Deno KV state.** Each match is one KV entry. Every write is a versionstamp-checked atomic commit with retry, so concurrent requests on several Deno Deploy isolates never lose a bid.
- **Lazy clock.** There are no timers or cron jobs. A round whose deadline has passed is resolved on the next read, so idle matches cost nothing.
- **Cheap long-polling.** `?since=` waits on `kv.watch`, so one request covers each change. Bots bid on the server at round start, so a human-vs-3-bots game takes about 20 requests in total.
- **No leaks.** Tokens, unrevealed bids and hidden mystery values are never sent to clients. Names are sanitised.
- Matches expire after 3 days. Lobbies with nobody in them expire after 30 minutes.
