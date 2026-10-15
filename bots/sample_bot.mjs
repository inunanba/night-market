// Night Market sample bot for Node 18+/Deno/Bun.  node sample_bot.mjs [BASE_URL] [CODE]
const BASE = (process?.argv?.[2] ?? "http://localhost:8000").replace(/\/$/, "");
const CODE = process?.argv?.[3];
const call = async (method, path, body, token) => {
  const r = await fetch(BASE + path, {
    method, body: body && JSON.stringify(body),
    headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }) },
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${r.status} ${j.error}: ${j.message}`);
  return j;
};
const j = CODE
  ? await call("POST", `/api/matches/${CODE}/join`, { name: "JSBot" })
  : await call("POST", "/api/quickplay", { name: "JSBot", seats: 4 });
let s = j.state;
while (s.status !== "done") {
  if (s.you.mustBid) {
    const left = s.rounds - s.round + 1, coins = s.you.coins;
    const value = s.stall.points ?? 2.75;
    const bid = left === 1 ? coins : Math.min(coins, Math.round((coins / left) * (value / 3.4)));
    console.log(`round ${s.round}: ${s.stall.name} -> ${bid}`);
    s = await call("POST", `/api/matches/${j.code}/bid`, { bid }, j.token);
  } else s = await call("GET", `/api/matches/${j.code}?since=${s.version}`, null, j.token);
}
console.table(s.final.map(({ rank, name, total }) => ({ rank, name, total })));
