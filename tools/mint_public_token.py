#!/usr/bin/env python3
"""Mint a browser-safe public (pk.) Mapbox token from the secret (sk.) one in .env.

GL JS refuses secret tokens. This uses the Tokens API (the intended use of an
sk token) to create a public token scoped to exactly what the map needs, then
rewrites .env:  MAPBOX_TOKEN=pk...  (client)  /  MAPBOX_SECRET=sk...  (kept).
The secret is never printed.
"""
import base64
import json
import sys
import urllib.request

ENV = "/Users/pinheirochagas/Documents/code/homdred_miler/.env"
SCOPES = ["styles:read", "styles:tiles", "fonts:read"]

lines = open(ENV).read().splitlines()
env = {}
for ln in lines:
    if "=" in ln and not ln.lstrip().startswith("#"):
        k, v = ln.split("=", 1)
        env[k.strip()] = v.strip()

tok = env.get("MAPBOX_TOKEN", "")
if tok.startswith("pk."):
    print("MAPBOX_TOKEN is already public — nothing to do.")
    sys.exit(0)
if not tok.startswith("sk."):
    print("No sk. token found in .env")
    sys.exit(1)

payload = tok.split(".")[1]
payload += "=" * (-len(payload) % 4)
username = json.loads(base64.urlsafe_b64decode(payload))["u"]
print(f"account: {username}")

req = urllib.request.Request(
    f"https://api.mapbox.com/tokens/v2/{username}?access_token={tok}",
    data=json.dumps({"note": "homedred-miler web map (auto-minted)", "scopes": SCOPES}).encode(),
    headers={"Content-Type": "application/json"},
    method="POST",
)
try:
    with urllib.request.urlopen(req) as r:
        pk = json.loads(r.read())["token"]
except urllib.error.HTTPError as e:
    print(f"Tokens API refused ({e.code}): {e.read().decode()[:200]}")
    print("-> The sk token lacks tokens:write. Create a pk token manually at")
    print("   https://account.mapbox.com/access-tokens and set MAPBOX_TOKEN=pk... in .env")
    sys.exit(2)

if not pk.startswith("pk."):
    print("Unexpected token type returned; aborting.")
    sys.exit(2)

out = [f"MAPBOX_TOKEN={pk}", f"MAPBOX_SECRET={tok}"]
for ln in lines:
    if not ln.startswith("MAPBOX_TOKEN=") and ln.strip():
        out.append(ln)
open(ENV, "w").write("\n".join(out) + "\n")
print(f"minted pk token …{pk[-6:]} with scopes {SCOPES}")
print("wrote .env (MAPBOX_TOKEN=pk…, secret kept as MAPBOX_SECRET)")
