import {
  ApiError, cleanName, createMatch, findByToken, initKv, joinMatch, lobbyExpired,
  mutate, placeBid, readTicked, startMatch, view, waitForChange,
} from "./engine.ts";
import { COINS_PER_POINT, PERSONAS, RAINBOW_BONUS, ROUNDS, SET_BONUS, START_COINS } from "./game.ts";

const HTML = await Deno.readTextFile(new URL("./static/index.html", import.meta.url));
const BOT_PY = await Deno.readTextFile(new URL("./bots/sample_bot.py", import.meta.url));
const BOT_JS = await Deno.readTextFile(new URL("./bots/sample_bot.mjs", import.meta.url));
const ETAG = `"${(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(HTML + BOT_PY + BOT_JS)))
  .byteLength}-${HTML.length}-${BOT_PY.length}"`;

const RULES = {
  summary:
    `2-4 players, ${ROUNDS} rounds. Each round one market stall is up for auction. Everyone secretly bids coins from a ${START_COINS}-coin purse that must last the whole night. Highest bid wins the stall and pays. Tied top bids are BURNED (those players pay and get nothing) and the stall drops to the next-highest untied bid. Score = stall points + ${SET_BONUS} per colour with 3+ stalls + ${RAINBOW_BONUS} for owning all 4 colours + 1 per ${COINS_PER_POINT} leftover coins. Mystery stalls (🔮📦🎭🏮) hide their value (-2, 1, 5 or 7) until sold. You always see the next stall coming.`,
  rounds: ROUNDS, startCoins: START_COINS, setBonus: SET_BONUS, rainbowBonus: RAINBOW_BONUS,
  coinsPerPoint: COINS_PER_POINT, colours: ["red", "gold", "jade", "indigo"],
  mysteryValues: [-2, 1, 5, 7],
  bots: Object.fromEntries(Object.entries(PERSONAS).map(([k, v]) => [k, `${v.name}: ${v.blurb}`])),
};

const API_DOC = {
  name: "Night Market API",
  base: "/api",
  auth: "Player token from create/join/quickplay. Send as header 'Authorization: Bearer <token>' or ?token=.",
  endpoints: {
    "POST /api/quickplay": "{name?, seats?:2-4, turnSeconds?:5-300} -> new match vs bots, already started. Returns {code, token, playerId, state}",
    "POST /api/matches": "{name?, seats?:2-4, turnSeconds?, bots?} -> lobby. Returns {code, token, playerId, joinUrl}",
    "POST /api/matches/{code}/join": "{name?} -> {token, playerId}. Match auto-starts when full.",
    "POST /api/matches/{code}/start": "(host token) start now; empty seats are filled with bots",
    "GET /api/matches/{code}?since={version}": "State (personalised if token given). With since=, long-polls up to 25s until something changes — use this instead of tight polling.",
    "POST /api/matches/{code}/bid": "{bid: integer 0..yourCoins} sealed bid for the current round",
    "GET /api/matches/{code}/log": "Full round-by-round history (replay data)",
    "GET /api/rules": "Rules as JSON",
  },
  loop: "quickplay -> while state.status!='done': if state.you.mustBid: POST bid; else GET state?since=state.version",
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "no-store" },
  });

async function body(req: Request): Promise<Record<string, unknown>> {
  if (req.method !== "POST") return {};
  const t = await req.text();
  if (!t.trim()) return {};
  if (t.length > 4096) throw new ApiError(413, "too_large", "Body too large");
  try {
    const v = JSON.parse(t);
    return v && typeof v === "object" ? v : {};
  } catch {
    throw new ApiError(400, "bad_json", "Body must be JSON");
  }
}

function tokenOf(req: Request, url: URL) {
  const h = req.headers.get("authorization");
  if (h?.toLowerCase().startsWith("bearer ")) return h.slice(7).trim();
  return url.searchParams.get("token");
}

// per-isolate soft rate limit to protect the free-tier quota
const hits = new Map<string, { n: number; t: number }>();
function limited(req: Request, info: Deno.ServeHandlerInfo) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0] ??
    (info.remoteAddr as Deno.NetAddr).hostname ?? "?";
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h.t > 10_000) {
    hits.set(ip, { n: 1, t: now });
    if (hits.size > 5000) hits.clear();
    return false;
  }
  return ++h.n > 60;
}

export async function handler(req: Request, info: Deno.ServeHandlerInfo): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname;
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, authorization", "access-control-allow-methods": "GET, POST" },
    });
  }
  try {
    if (!p.startsWith("/api")) {
      const file = p === "/bots/sample_bot.py" ? [BOT_PY, "text/x-python"] : p === "/bots/sample_bot.mjs" ? [BOT_JS, "text/javascript"] : null;
      if (p === "/favicon.ico") return new Response(null, { status: 204, headers: { "cache-control": "public, max-age=86400" } });
      if (req.headers.get("if-none-match") === ETAG) return new Response(null, { status: 304, headers: { etag: ETAG } });
      return new Response(file ? file[0] : HTML, {
        headers: { "content-type": `${file ? file[1] : "text/html"}; charset=utf-8`, etag: ETAG, "cache-control": "public, max-age=300" },
      });
    }
    if (limited(req, info)) throw new ApiError(429, "slow_down", "Too many requests; use ?since= long-polling");
    if (p === "/api" || p === "/api/") return json(API_DOC);
    if (p === "/api/rules") return json(RULES);
    if (p === "/api/health") return json({ ok: true });

    if (req.method === "POST" && (p === "/api/quickplay" || p === "/api/matches")) {
      const b = await body(req);
      const quick = p === "/api/quickplay";
      const { m, player } = await createMatch({
        name: cleanName(b.name) || (quick ? "Agent" : "Host"), seats: b.seats as number,
        turnSeconds: b.turnSeconds as number, bots: b.bots as number, start: quick, seed: b.seed as number,
      });
      return json({
        code: m.code, token: player.token, playerId: player.id,
        joinUrl: `${url.origin}/#${m.code}`, state: view(m, player),
      }, 201);
    }

    const mm = p.match(/^\/api\/matches\/([A-Za-z]{4})(\/[a-z]+)?$/);
    if (!mm) throw new ApiError(404, "not_found", "Unknown endpoint; see GET /api");
    const code = mm[1].toUpperCase();
    const action = mm[2] ?? "";
    const token = tokenOf(req, url);

    if (req.method === "GET" && action === "") {
      const since = url.searchParams.get("since");
      const m = since !== null
        ? await waitForChange(code, Number(since), 25_000)
        : await readTicked(code);
      if (lobbyExpired(m, Date.now())) throw new ApiError(410, "expired", "Lobby expired");
      const me = token ? m.players.find((x) => x.token === token) : undefined;
      if (token && !me) throw new ApiError(401, "bad_token", "Invalid player token");
      return json(view(m, me));
    }
    if (req.method === "GET" && action === "/log") {
      const m = await readTicked(code);
      return json({
        code: m.code, status: m.status, seed: m.seed,
        players: m.players.map((x) => ({ id: x.id, name: x.name, isBot: x.isBot })),
        deck: m.status === "done" ? m.deck : undefined, history: m.history, final: m.final ?? null,
      });
    }
    if (req.method === "POST" && action === "/join") {
      const b = await body(req);
      const { m, out } = await mutate(code, (m) => joinMatch(m, cleanName(b.name)));
      return json({ code, token: out.token, playerId: out.id, state: view(m, out) }, 201);
    }
    if (req.method === "POST" && action === "/start") {
      const { m, out } = await mutate(code, (m) => {
        const me = findByToken(m, token);
        if (me.id !== m.hostId) throw new ApiError(403, "not_host", "Only the host can start");
        startMatch(m, Date.now());
        return me;
      });
      return json(view(m, out));
    }
    if (req.method === "POST" && action === "/bid") {
      const b = await body(req);
      const { m, out } = await mutate(code, (m) => {
        const me = findByToken(m, token);
        placeBid(m, me, b.bid, Date.now());
        return me;
      });
      return json(view(m, out));
    }
    throw new ApiError(405, "method_not_allowed", "Wrong method; see GET /api");
  } catch (e) {
    if (e instanceof ApiError) return json({ error: e.code, message: e.message }, e.status);
    console.error(e);
    return json({ error: "internal", message: "Something went wrong" }, 500);
  }
}

if (import.meta.main) {
  await initKv(Deno.env.get("KV_PATH") || undefined);
  Deno.serve({ port: Number(Deno.env.get("PORT") ?? 8000) }, handler);
}
