#!/usr/bin/env python3
"""Night Market sample bot (stdlib only).
Usage: python3 sample_bot.py [BASE_URL] [MATCH_CODE]
  no code  -> quickplay vs server bots;  with code -> join that lobby."""
import json, random, sys, urllib.request

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8000").rstrip("/")
CODE = sys.argv[2] if len(sys.argv) > 2 else None

def call(method, path, body=None, token=None):
    req = urllib.request.Request(BASE + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"content-type": "application/json", **({"authorization": f"Bearer {token}"} if token else {})})
    with urllib.request.urlopen(req, timeout=40) as r:
        return json.loads(r.read())

def choose_bid(s):
    me = next(p for p in s["players"] if p["id"] == s["you"]["id"])
    stall, coins = s["stall"], s["you"]["coins"]
    left = s["rounds"] - s["round"] + 1
    value = stall["points"] if stall["points"] is not None else 2.75   # mystery: avg of -2,1,5,7
    same = sum(1 for x in me["stalls"] if x["colour"] == stall["colour"])
    value += 4 if same == 2 else 1.5 if same == 1 else 0              # chasing a 3-colour set
    if left == 1: return coins if value >= 3 else coins // 3
    bid = round(coins / left * value / 3.4 * random.uniform(0.7, 1.3)) + random.choice((-1, 0, 0, 1))  # jitter: identical bots won't tie-burn forever
    rivals = max((p["coins"] for p in s["players"] if p["id"] != me["id"]), default=0)
    if bid > 0 and bid == rivals: bid -= 1                              # dodge the burn-tie
    return max(0, min(coins, bid))

if CODE:
    j = call("POST", f"/api/matches/{CODE}/join", {"name": "PyBot"})
else:
    j = call("POST", "/api/quickplay", {"name": "PyBot", "seats": 4})
token, s = j["token"], j["state"]
print(f"match {j['code']} as {j['playerId']}")
while s["status"] != "done":
    if s["you"]["mustBid"]:
        bid = choose_bid(s)
        print(f"round {s['round']}: {s['stall']['emoji']} {s['stall']['name']} -> bid {bid}")
        s = call("POST", f"/api/matches/{j['code']}/bid", {"bid": bid}, token)
    else:  # long-poll: returns as soon as anything changes (or after 25s)
        s = call("GET", f"/api/matches/{j['code']}?since={s['version']}", token=token)
for r in s["final"]:
    print(f"#{r['rank']} {r['name']}: {r['total']} pts")
