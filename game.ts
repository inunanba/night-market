// Night Market — pure game logic (no I/O). Deterministic given a seed.
export type Colour = "red" | "gold" | "jade" | "indigo";
export const COLOURS: Colour[] = ["red", "gold", "jade", "indigo"];

export interface Stall {
  id: string;
  name: string;
  emoji: string;
  colour: Colour;
  points: number; // for mystery stalls this is the hidden true value
  mystery: boolean;
}

export interface Player {
  id: string;
  name: string;
  isBot: boolean;
  persona?: string;
  token: string; // secret, never serialised to clients
  coins: number;
  stalls: Stall[];
  lastSeen: number;
}

export interface RoundResult {
  round: number;
  stall: Stall;
  bids: Record<string, number>;
  winner: string | null;
  price: number;
  burned: string[]; // players whose tied bids were burned
  timedOut: string[];
  at: number;
}

export interface Match {
  code: string;
  createdAt: number;
  status: "lobby" | "playing" | "done";
  seats: number;
  turnMs: number;
  hostId: string;
  players: Player[];
  deck: Stall[]; // the 8 stalls of this match, in order
  round: number; // 0-based index into deck
  bids: Record<string, number>;
  deadline: number;
  history: RoundResult[];
  seed: number;
  version: number;
  final?: Score[];
  startedAt?: number;
  endedAt?: number;
}

export interface Score {
  id: string;
  name: string;
  stallPoints: number;
  setBonus: number;
  rainbowBonus: number;
  coinPoints: number;
  total: number;
  rank: number;
}

export const ROUNDS = 8;
export const START_COINS = 15;
export const SET_BONUS = 4; // 3+ stalls of one colour
export const RAINBOW_BONUS = 5; // at least one stall of all 4 colours
export const COINS_PER_POINT = 3;

const STALL_DEFS: [string, string, Colour, number][] = [
  ["Dumpling Cart", "🥟", "red", 3],
  ["Firecracker Kiosk", "🧨", "red", 2],
  ["Chili Oil Stand", "🌶️", "red", 4],
  ["Lucky Cat Shop", "🐱", "gold", 2],
  ["Mango Shaved Ice", "🥭", "gold", 3],
  ["Goldfish Scoop", "🐟", "gold", 4],
  ["Matcha Tent", "🍵", "jade", 3],
  ["Bonsai Barrow", "🌳", "jade", 2],
  ["Jade Bangle Booth", "💚", "jade", 4],
  ["Star Map Seller", "🌌", "indigo", 3],
  ["Ink & Brush Stall", "🖌️", "indigo", 2],
  ["Moon Cake Oven", "🥮", "indigo", 4],
];
const MYSTERY_DEFS: [string, string, Colour][] = [
  ["Fortune Teller", "🔮", "indigo"],
  ["Mystery Crate", "📦", "gold"],
  ["Masked Merchant", "🎭", "red"],
  ["Lantern Lottery", "🏮", "jade"],
];
const MYSTERY_VALUES = [-2, 1, 5, 7];

export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(arr: T[], r: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function buildDeck(seed: number): Stall[] {
  const r = rng(seed);
  const normal = STALL_DEFS.map(([name, emoji, colour, points], i) => ({
    id: `s${i}`, name, emoji, colour, points, mystery: false,
  }));
  const vals = shuffle(MYSTERY_VALUES, r);
  const myst = shuffle(MYSTERY_DEFS, r).slice(0, 2).map(([name, emoji, colour], i) => ({
    id: `m${i}`, name, emoji, colour, points: vals[i], mystery: true,
  }));
  return shuffle([...shuffle(normal, r).slice(0, ROUNDS - 2), ...myst], r);
}

/** Resolve sealed bids. Highest bid wins and pays. Tied top bids are BURNED
 *  (those players pay and get nothing) and the stall drops to the next
 *  highest untied bid. If everybody ties, the stall goes unsold. */
export function resolveBids(bids: Record<string, number>, order: string[]) {
  const burned: string[] = [];
  let pool = order.filter((id) => id in bids);
  while (pool.length) {
    const top = Math.max(...pool.map((id) => bids[id]));
    const at = pool.filter((id) => bids[id] === top);
    if (at.length === 1) return { winner: at[0], price: top, burned };
    if (top > 0) burned.push(...at);
    pool = pool.filter((id) => bids[id] !== top);
  }
  return { winner: null as string | null, price: 0, burned };
}

export function scorePlayers(players: Player[]): Score[] {
  const rows = players.map((p) => {
    const stallPoints = p.stalls.reduce((s, x) => s + x.points, 0);
    const counts = COLOURS.map((c) => p.stalls.filter((s) => s.colour === c).length);
    const setBonus = counts.filter((n) => n >= 3).length * SET_BONUS;
    const rainbowBonus = counts.every((n) => n > 0) ? RAINBOW_BONUS : 0;
    const coinPoints = Math.floor(p.coins / COINS_PER_POINT);
    return {
      id: p.id, name: p.name, stallPoints, setBonus, rainbowBonus, coinPoints,
      total: stallPoints + setBonus + rainbowBonus + coinPoints, rank: 0,
      _coins: p.coins,
    };
  });
  const sorted = rows.slice().sort((a, b) => b.total - a.total || b._coins - a._coins);
  sorted.forEach((r, i) => {
    const prev = sorted[i - 1];
    r.rank = prev && prev.total === r.total && prev._coins === r._coins ? prev.rank : i + 1;
  });
  return sorted.map(({ _coins, ...r }) => r);
}

// ---------------------------------------------------------------- bots
export const PERSONAS: Record<string, { name: string; greed: number; bluff: number; blurb: string }> = {
  moth: { name: "Miser Moth", greed: 0.75, bluff: 0.1, blurb: "hoards coins, pounces on bargains" },
  tanuki: { name: "Tanuki Tom", greed: 1.0, bluff: 0.2, blurb: "steady, sensible, a little sneaky" },
  vixen: { name: "Vixen Vee", greed: 1.3, bluff: 0.3, blurb: "bids big, bluffs bigger" },
  owl: { name: "Night Owl", greed: 1.1, bluff: 0.05, blurb: "collects colour sets obsessively" },
};

/** Value of a stall to a player, counting set/rainbow progress. Public so agents can mirror it. */
export function stallValue(stall: Stall, mine: Stall[]): number {
  let v = stall.mystery ? 2.75 : stall.points;
  const same = mine.filter((s) => s.colour === stall.colour).length;
  if (same === 2) v += SET_BONUS;
  else if (same === 1) v += 1.5;
  const have = new Set(mine.map((s) => s.colour));
  if (!have.has(stall.colour)) v += have.size === 3 ? RAINBOW_BONUS : have.size * 0.6;
  return v;
}

export function botBid(m: Match, p: Player, r: () => number): number {
  const persona = PERSONAS[p.persona ?? "tanuki"] ?? PERSONAS.tanuki;
  const stall = m.deck[m.round];
  const left = ROUNDS - m.round;
  if (p.coins === 0) return 0;
  const v = stallValue(stall, p.stalls);
  // budget per point of value: coins are worth 1/3 point at the end, so a coin
  // is "worth spending" when value per coin beats that, scaled by rounds left.
  const avg = 3.6;
  // what is this stall worth to me in coins?
  const share = (left * avg) / m.players.length * (m.players.length === 2 ? 0.75 : 1.2);
  const maxPay = v * (p.coins / share) * persona.greed;
  // what will the hungriest rival probably bid? (same heuristic, from their view)
  const guess = Math.max(...m.players.filter((x) => x.id !== p.id).map((x) =>
    (x.coins / left) * (stallValue(stall, x.stalls) / avg)
  ));
  const over = guess * (0.7 + r() * 0.6) + r() * 2.5;
  let bid = over <= maxPay ? over : r() * 1.8; // outbid or lowball
  if (persona === PERSONAS.owl) {
    const same = p.stalls.filter((s) => s.colour === stall.colour).length;
    if (same >= 1) bid *= 1.35;
  }
  if (r() < persona.bluff) bid = r() < 0.5 ? 0 : bid + 2 + Math.floor(r() * 3);
  if (left === 1) bid = Math.max(bid, v > 3 ? p.coins * 0.6 : p.coins * 0.25);
  return Math.max(0, Math.min(p.coins, Math.round(bid)));
}
