// State transitions + KV persistence. All mutations go through `mutate`,
// which uses a versionstamp-checked atomic write so concurrent isolates on
// Deno Deploy can never clobber each other.
import {
  botBid, buildDeck, Match, PERSONAS, Player, resolveBids, rng, ROUNDS, scorePlayers,
  START_COINS,
} from "./game.ts";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ";
const TTL = 1000 * 60 * 60 * 24 * 3; // keep matches (and replays) for 3 days
const LOBBY_IDLE_MS = 1000 * 60 * 30;

let kv: Deno.Kv;
export async function initKv(path?: string) {
  kv = await Deno.openKv(path);
  return kv;
}

const rand = (n: number) => crypto.getRandomValues(new Uint32Array(n));
export function newToken() {
  return Array.from(rand(4), (x) => x.toString(36).padStart(7, "0")).join("");
}
function newCode() {
  return Array.from(rand(4), (x) => CODE_ALPHABET[x % CODE_ALPHABET.length]).join("");
}

export async function getMatch(code: string): Promise<Match> {
  const res = await kv.get<Match>(["match", code.toUpperCase()]);
  if (!res.value) throw new ApiError(404, "no_such_match", `No match with code ${code}`);
  return res.value;
}

/** Apply fn to the latest match state with optimistic concurrency. */
export async function mutate<T>(code: string, fn: (m: Match) => T): Promise<{ m: Match; out: T }> {
  const key = ["match", code.toUpperCase()];
  for (let i = 0; i < 25; i++) {
    const cur = await kv.get<Match>(key);
    if (!cur.value) throw new ApiError(404, "no_such_match", `No match with code ${code}`);
    const m = cur.value;
    const out = fn(m);
    m.version = (m.version ?? 0) + 1;
    const ok = await kv.atomic().check(cur).set(key, m, { expireIn: TTL }).commit();
    if (ok.ok) return { m, out };
    await new Promise((r) => setTimeout(r, 5 + Math.random() * 20 * (i + 1)));
  }
  throw new ApiError(503, "busy", "Match is busy, retry");
}

/** Read and, if the clock says something is due (deadline passed), advance. */
export async function readTicked(code: string): Promise<Match> {
  const m = await getMatch(code);
  if (needsTick(m, Date.now())) return (await mutate(code, (x) => tick(x, Date.now()))).m;
  return m;
}

export function needsTick(m: Match, now: number) {
  return m.status === "playing" && (now >= m.deadline || allBid(m));
}

const allBid = (m: Match) => m.players.every((p) => p.id in m.bids);

function makePlayer(name: string, isBot: boolean, idx: number, persona?: string): Player {
  return {
    id: `p${idx + 1}`, name: cleanName(name) || `Player ${idx + 1}`, isBot, persona,
    token: newToken(), coins: START_COINS, stalls: [], lastSeen: Date.now(),
  };
}

export function cleanName(s: unknown): string {
  return String(s ?? "").replace(/[<>&"'`\u0000-\u001f]/g, "").trim().slice(0, 20);
}

export interface CreateOpts {
  name?: string;
  seats?: number;
  turnSeconds?: number;
  bots?: number; // add this many bots right away
  start?: boolean; // start immediately (fills empty seats with bots)
  seed?: number;
}

export async function createMatch(o: CreateOpts) {
  const seats = Math.max(2, Math.min(4, Math.floor(Number(o.seats ?? 4)) || 4));
  const turnMs = Math.max(5, Math.min(300, Math.floor(Number(o.turnSeconds ?? 60)) || 60)) * 1000;
  const seed = Number.isFinite(Number(o.seed)) && o.seed !== undefined ? Number(o.seed) >>> 0 : rand(1)[0];
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = newCode();
    const host = makePlayer(o.name ?? "Host", false, 0);
    const m: Match = {
      code, createdAt: Date.now(), status: "lobby", seats, turnMs, hostId: host.id,
      players: [host], deck: buildDeck(seed), round: 0, bids: {}, deadline: 0, history: [], seed, version: 1,
    };
    const nb = Math.max(0, Math.min(seats - 1, Math.floor(Number(o.bots ?? 0)) || 0));
    for (let i = 0; i < nb; i++) addBot(m);
    if (o.start) startMatch(m, Date.now());
    const key = ["match", code];
    const ok = await kv.atomic().check({ key, versionstamp: null }).set(key, m, { expireIn: TTL })
      .commit();
    if (ok.ok) {
      await kv.set(["recent", m.createdAt, code], 1, { expireIn: TTL });
      return { m, player: host };
    }
  }
  throw new ApiError(503, "busy", "Could not allocate a match code");
}

function addBot(m: Match) {
  const used = new Set(m.players.map((p) => p.persona));
  const order = ["tanuki", "vixen", "moth", "owl"];
  const key = order.find((k) => !used.has(k)) ?? "tanuki";
  const p = makePlayer(`🤖 ${PERSONAS[key].name}`, true, m.players.length, key);
  m.players.push(p);
}

export function joinMatch(m: Match, name: string): Player {
  if (m.status !== "lobby") throw new ApiError(409, "already_started", "Match already started");
  if (m.players.length >= m.seats) throw new ApiError(409, "full", "Match is full");
  const p = makePlayer(name, false, m.players.length);
  m.players.push(p);
  if (m.players.length === m.seats) startMatch(m, Date.now());
  return p;
}

export function startMatch(m: Match, now: number) {
  if (m.status !== "lobby") return;
  while (m.players.length < m.seats) addBot(m);
  m.status = "playing";
  m.startedAt = now;
  beginRound(m, now);
}

function beginRound(m: Match, now: number) {
  m.bids = {};
  m.deadline = now + m.turnMs;
  const r = rng(m.seed * 31 + m.round * 7919);
  for (const p of m.players) if (p.isBot) m.bids[p.id] = botBid(m, p, r);
}

export function placeBid(m: Match, p: Player, bid: unknown, now: number) {
  if (m.status === "lobby") throw new ApiError(409, "not_started", "Match has not started yet");
  if (m.status === "done") throw new ApiError(409, "game_over", "Match is over");
  const n = Number(bid);
  if (!Number.isInteger(n) || n < 0 || n > p.coins) {
    throw new ApiError(400, "bad_bid", `Bid must be an integer from 0 to ${p.coins}`);
  }
  if (p.id in m.bids) throw new ApiError(409, "already_bid", "You already bid this round");
  m.bids[p.id] = n;
  p.lastSeen = now;
  tick(m, now);
}

/** Resolve rounds whose bids are all in or whose deadline passed. */
export function tick(m: Match, now: number) {
  let guard = 0;
  while (m.status === "playing" && (allBid(m) || now >= m.deadline) && guard++ < ROUNDS) {
    const timedOut: string[] = [];
    for (const p of m.players) {
      if (!(p.id in m.bids)) {
        m.bids[p.id] = 0;
        timedOut.push(p.id);
      }
    }
    const stall = m.deck[m.round];
    const { winner, price, burned } = resolveBids(m.bids, m.players.map((p) => p.id));
    for (const id of burned) m.players.find((p) => p.id === id)!.coins -= m.bids[id];
    if (winner) {
      const w = m.players.find((p) => p.id === winner)!;
      w.coins -= price;
      w.stalls.push(stall);
    }
    m.history.push({
      round: m.round + 1, stall, bids: { ...m.bids }, winner, price, burned, timedOut, at: now,
    });
    m.round++;
    if (m.round >= ROUNDS) {
      m.status = "done";
      m.endedAt = now;
      m.bids = {};
      m.final = scorePlayers(m.players);
    } else {
      // If a round timed out, the next deadline starts from now, not the stale one.
      beginRound(m, now);
    }
  }
}

export function lobbyExpired(m: Match, now: number) {
  return m.status === "lobby" && now - m.createdAt > LOBBY_IDLE_MS;
}

export function findByToken(m: Match, token: string | null): Player {
  const p = token ? m.players.find((x) => x.token === token) : undefined;
  if (!p) throw new ApiError(401, "bad_token", "Missing or invalid player token");
  return p;
}

/** The public / per-player view. Never leaks tokens, hidden bids or mystery values. */
export function view(m: Match, me?: Player) {
  const now = Date.now();
  const cur = m.status === "playing" ? m.deck[m.round] : null;
  const hide = (s: typeof cur) => s && (s.mystery ? { ...s, points: null } : s);
  return {
    code: m.code,
    version: m.version,
    status: m.status,
    round: m.status === "done" ? ROUNDS : m.round + 1,
    rounds: ROUNDS,
    seats: m.seats,
    turnSeconds: m.turnMs / 1000,
    secondsLeft: m.status === "playing" ? Math.max(0, Math.ceil((m.deadline - now) / 1000)) : null,
    stall: hide(cur),
    nextStall: m.status === "playing" && m.round + 1 < ROUNDS ? hide(m.deck[m.round + 1]) : null,
    players: m.players.map((p) => ({
      id: p.id, name: p.name, isBot: p.isBot, coins: p.coins, host: p.id === m.hostId,
      hasBid: m.status === "playing" ? p.id in m.bids : false,
      stalls: p.stalls.map((s) => ({ name: s.name, emoji: s.emoji, colour: s.colour, points: s.points, mystery: s.mystery })),
    })),
    history: m.history,
    final: m.final ?? null,
    you: me
      ? {
        id: me.id, name: me.name, coins: me.coins, host: me.id === m.hostId,
        yourBid: m.bids[me.id] ?? null,
        mustBid: m.status === "playing" && !(me.id in m.bids),
        legalBids: m.status === "playing" && !(me.id in m.bids) ? { min: 0, max: me.coins } : null,
      }
      : null,
  };
}

/** Long-poll: resolve when the match version differs from `since`, the round
 *  deadline passes, or `maxMs` elapses. Uses kv.watch so it costs ~no CPU. */
export async function waitForChange(code: string, since: number, maxMs: number): Promise<Match> {
  let m = await readTicked(code);
  if (m.version !== since || m.status !== "playing" && m.status !== "lobby") return m;
  const until = Math.min(Date.now() + maxMs, m.status === "playing" ? m.deadline + 50 : Infinity);
  const stream = kv.watch<[Match]>([["match", code.toUpperCase()]]);
  const reader = stream.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<null>((r) => timer = setTimeout(() => r(null), Math.max(0, until - Date.now())));
    while (true) {
      const next = await Promise.race([reader.read(), timeout]);
      if (!next || next.done) break;
      const v = next.value[0].value;
      if (v && v.version !== since) return v;
    }
  } finally {
    clearTimeout(timer);
    reader.cancel().catch(() => {});
  }
  return await readTicked(code);
}
