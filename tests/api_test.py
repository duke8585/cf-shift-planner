"""End-to-end API test for shift-planner. Creates its own plans and deletes them again.

Usage: python3 tests/api_test.py <base_url>   (e.g. http://localhost:8787 with `npm run dev` running)
"""

import json
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from typing import Any

BASE = sys.argv[1].rstrip("/") + "/api"
failures: list[str] = []


def call(method: str, path: str, body: dict[str, Any] | None = None) -> tuple[int, Any]:
    """Send a JSON request to the API and return (status, parsed body), also for error statuses."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method, headers={"content-type": "application/json", "user-agent": "shift-planner-smoke/1.0"})
    try:
        with urllib.request.urlopen(req) as res:
            return res.status, json.loads(res.read() or b"{}")
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read() or b"{}")


def check(label: str, cond: bool, detail: Any = "") -> None:
    """Print PASS/FAIL for one assertion and remember failures for the exit code."""
    print(("PASS " if cond else "FAIL ") + label + ("" if cond else f"  -> {detail}"))
    if not cond:
        failures.append(label)


for _ in range(60):
    try:
        call("GET", "/plans")
        break
    except Exception:
        time.sleep(1)

# --- open plan ---
st, r = call("POST", "/plans", {"name": "  Test Fest  "})
check("create open plan 201", st == 201, r)
open_id = r["id"]
st, r = call("POST", "/plans", {"name": ""})
check("empty name rejected 400", st == 400, r)

shifts = [
    {"role": "Bar", "date": "2026-10-10", "startTime": "14:00", "capacity": 2},
    {"role": "Bar", "date": "2026-10-10", "startTime": "16:00", "capacity": 1},
    {"role": "Läufer", "date": "2026-10-11", "startTime": "14:00", "capacity": 3},
]
st, r = call("PUT", f"/plans/{open_id}/shifts", {"shifts": shifts})
check("save layout without password", st == 200, r)
st, r = call("PUT", f"/plans/{open_id}/shifts", {"shifts": [{"role": "X", "date": "bad", "startTime": "14:00", "capacity": 1}]})
check("invalid date rejected 400", st == 400, r)

st, plan = call("GET", f"/plans/{open_id}")
check("get plan shape", st == 200 and plan["plan"]["name"] == "Test Fest" and plan["plan"]["hasAdminPassword"] is False and len(plan["shifts"]) == 3, plan)
bar14 = next(s for s in plan["shifts"] if s["startTime"] == "14:00" and s["role"] == "Bar")
bar16 = next(s for s in plan["shifts"] if s["startTime"] == "16:00")

st, a = call("POST", f"/plans/{open_id}/shifts/{bar14['id']}/signup", {"name": "Max"})
check("signup 201", st == 201 and a["name"] == "Max", a)
st, b = call("POST", f"/plans/{open_id}/shifts/{bar14['id']}/signup", {"name": "Anna"})
check("second signup 201", st == 201, b)
st, r = call("POST", f"/plans/{open_id}/shifts/{bar14['id']}/signup", {"name": "Late"})
check("full shift 409", st == 409, r)
st, r = call("POST", f"/plans/{open_id}/shifts/nope/signup", {"name": "X"})
check("unknown shift 404", st == 404, r)

# concurrent race for a capacity-1 shift
with ThreadPoolExecutor(8) as pool:
    codes = list(pool.map(lambda i: call("POST", f"/plans/{open_id}/shifts/{bar16['id']}/signup", {"name": f"Racer{i}"})[0], range(8)))
check("race: exactly one of 8 concurrent signups wins", codes.count(201) == 1 and codes.count(409) == 7, codes)

st, r = call("DELETE", f"/plans/{open_id}/signups/{b['id']}")
check("undo signup", st == 200, r)
st, plan = call("GET", f"/plans/{open_id}")
check("signup count after undo == 2", len(plan["signups"]) == 2, plan["signups"])

# layout save keeps signups of matched shifts, drops removed ones
kept = [{"id": bar14["id"], "role": "Bar", "date": "2026-10-10", "startTime": "14:00", "capacity": 5},
        {"role": "Kopfhörer", "date": "2026-10-12", "startTime": "18:00", "capacity": 1}]
st, r = call("PUT", f"/plans/{open_id}/shifts", {"shifts": kept})
check("layout replace", st == 200, r)
st, plan = call("GET", f"/plans/{open_id}")
check("matched shift kept its signup, removed shift's signup gone",
      [u["name"] for u in plan["signups"]] == ["Max"] and len(plan["shifts"]) == 2
      and next(s for s in plan["shifts"] if s["id"] == bar14["id"])["capacity"] == 5, plan)

st, v = call("GET", f"/plans/{open_id}/versions")
descs = [x["description"] for x in v["versions"]]
check("versions recorded newest first", st == 200 and v["versions"][0]["version_number"] > v["versions"][-1]["version_number"] and descs[-1] == "Plan created", descs)
print("     versions:", descs)

# restore the version right after the first layout save (3 shifts, 0 signups)
layout_v = next(x["version_number"] for x in v["versions"] if x["description"] == "Layout saved (3 shifts)")
st, r = call("POST", f"/plans/{open_id}/versions/{layout_v}/restore", {})
check("restore", st == 200, r)
st, plan = call("GET", f"/plans/{open_id}")
check("restore round-trip: 3 shifts, 0 signups", len(plan["shifts"]) == 3 and len(plan["signups"]) == 0, plan)
# restore a version with signups (after Anna's signup)
anna_v = next(x["version_number"] for x in v["versions"] if x["description"].startswith("Anna →"))
call("POST", f"/plans/{open_id}/versions/{anna_v}/restore", {})
st, plan = call("GET", f"/plans/{open_id}")
check("restore with signups brings names back", sorted(u["name"] for u in plan["signups"]) == ["Anna", "Max"], plan["signups"])
st, v = call("GET", f"/plans/{open_id}/versions")
check("restore logged as version", v["versions"][0]["description"] == f"Restored version #{anna_v}", v["versions"][0])

# --- protected plan ---
st, r = call("POST", "/plans", {"name": "Locked", "adminPassword": "s3cret"})
lock_id = r["id"]
st, r = call("GET", f"/plans/{lock_id}")
check("hasAdminPassword true", r["plan"]["hasAdminPassword"] is True, r)
check("verify wrong pw 403", call("POST", f"/plans/{lock_id}/verify", {"adminPassword": "nope"})[0] == 403)
check("verify right pw 200", call("POST", f"/plans/{lock_id}/verify", {"adminPassword": "s3cret"})[0] == 200)
check("save layout without pw 403", call("PUT", f"/plans/{lock_id}/shifts", {"shifts": shifts})[0] == 403)
check("save layout with pw 200", call("PUT", f"/plans/{lock_id}/shifts", {"shifts": shifts, "adminPassword": "s3cret"})[0] == 200)
check("restore without pw 403", call("POST", f"/plans/{lock_id}/versions/1/restore", {})[0] == 403)

st, r = call("POST", f"/plans/{lock_id}/duplicate", {})
dup_id = r.get("id")
st, d = call("GET", f"/plans/{dup_id}")
check("duplicate: name, shifts copied, password NOT copied",
      d["plan"]["name"] == "Locked (copy)" and len(d["shifts"]) == 3 and not d["plan"]["hasAdminPassword"], d)
st, dv = call("GET", f"/plans/{dup_id}/versions")
check("duplicate has version #1", [x["version_number"] for x in dv["versions"]] == [1], dv)

st, lst = call("GET", "/plans")
flags = {p["id"]: p["has_admin_password"] for p in lst["plans"]}
check("list includes password flag", flags.get(lock_id) == 1 and flags.get(open_id) == 0, flags)

check("duplicate with own pw", call("POST", f"/plans/{lock_id}/duplicate", {"name": "Own pw", "adminPassword": "other1"})[0] == 201)
own_id = next(p["id"] for p in call("GET", "/plans")[1]["plans"] if p["name"] == "Own pw")
check("copy: source pw rejected", call("POST", f"/plans/{own_id}/verify", {"adminPassword": "s3cret"})[0] == 403)
check("copy: own pw accepted", call("POST", f"/plans/{own_id}/verify", {"adminPassword": "other1"})[0] == 200)

# --- password hint ---
st, r = call("POST", f"/plans/{lock_id}/verify", {"adminPassword": "nope"})
check("wrong pw returns masked hint", r.get("params", {}).get("hint") == "s****t", r)
st, r = call("POST", "/plans", {"name": "Short pw", "adminPassword": "abc"})
short_id = r["id"]
st, r = call("POST", f"/plans/{short_id}/verify", {"adminPassword": "x"})
check("short pw fully masked", r["params"]["hint"] == "***", r)

# --- archive ---
check("archive without pw 403", call("POST", f"/plans/{lock_id}/archive", {})[0] == 403)
check("archive with pw", call("POST", f"/plans/{lock_id}/archive", {"adminPassword": "s3cret"})[0] == 200)
archived = {p["id"]: p["archived_at"] for p in call("GET", "/plans")[1]["plans"]}
check("archived_at set in list", bool(archived[lock_id]) and archived[open_id] is None, archived)
check("archived plan still opens", call("GET", f"/plans/{lock_id}")[0] == 200)
check("unarchive", call("POST", f"/plans/{lock_id}/archive", {"adminPassword": "s3cret", "archived": False})[0] == 200)
archived = {p["id"]: p["archived_at"] for p in call("GET", "/plans")[1]["plans"]}
check("archived_at cleared", archived[lock_id] is None, archived)

# --- name + description ---
check("edit without pw 403", call("PATCH", f"/plans/{lock_id}", {"name": "X"})[0] == 403)
st, r = call("PATCH", f"/plans/{lock_id}", {"name": " Locked 2 ", "description": "Meet at gate 2\nAsk for Max", "adminPassword": "s3cret"})
check("edit name + description", st == 200, r)
st, r = call("PATCH", f"/plans/{lock_id}", {"name": "Locked 2", "description": "x" * 2001, "adminPassword": "s3cret"})
check("description too long 400", st == 400 and r["code"] == "tooLong", r)
check("empty name rejected", call("PATCH", f"/plans/{lock_id}", {"name": " ", "adminPassword": "s3cret"})[0] == 400)
p = call("GET", f"/plans/{lock_id}")[1]["plan"]
check("edit persisted", p["name"] == "Locked 2" and p["description"] == "Meet at gate 2\nAsk for Max", p)

# --- copy with sign-ups + history ---
st, plan = call("GET", f"/plans/{lock_id}")
call("POST", f"/plans/{lock_id}/shifts/{plan['shifts'][0]['id']}/signup", {"name": "Anna"})
call("POST", f"/plans/{lock_id}/shifts/{plan['shifts'][1]['id']}/signup", {"name": "Ben"})
src_versions = call("GET", f"/plans/{lock_id}/versions")[1]["versions"]
st, r = call("POST", f"/plans/{lock_id}/duplicate", {"name": "Full copy", "withSignups": True})
full_id = r["id"]
full = call("GET", f"/plans/{full_id}")[1]
check("full copy has sign-ups", sorted(u["name"] for u in full["signups"]) == ["Anna", "Ben"], full["signups"])
check("full copy keeps description", full["plan"]["description"] == "Meet at gate 2\nAsk for Max", full["plan"])
check("full copy gets new shift ids", not {s["id"] for s in full["shifts"]} & {s["id"] for s in plan["shifts"]})
full_versions = call("GET", f"/plans/{full_id}/versions")[1]["versions"]
check("full copy keeps history + 1", len(full_versions) == len(src_versions) + 1, (len(full_versions), len(src_versions)))
anna_only = next(v["version_number"] for v in full_versions if v["description"].startswith("Anna →"))
check("restore old version in copy", call("POST", f"/plans/{full_id}/versions/{anna_only}/restore", {})[0] == 200)
check("copy restored to 1 sign-up", [u["name"] for u in call("GET", f"/plans/{full_id}")[1]["signups"]] == ["Anna"])
check("original untouched by copy restore", len(call("GET", f"/plans/{lock_id}")[1]["signups"]) == 2)
shifts_only = call("GET", f"/plans/{dup_id}")[1]
check("shifts-only copy has no sign-ups", shifts_only["signups"] == [], shifts_only["signups"])

check("delete protected without pw 403", call("DELETE", f"/plans/{lock_id}", {})[0] == 403)
for pid, pw in [(lock_id, "s3cret"), (dup_id, None), (own_id, "other1"), (short_id, "abc"), (full_id, None), (open_id, None)]:
    check(f"delete {pid[:8]}", call("DELETE", f"/plans/{pid}", {"adminPassword": pw})[0] == 200)
check("deleted plan 404", call("GET", f"/plans/{open_id}")[0] == 404)
check("unknown route 404", call("GET", "/nope")[0] == 404)

print(f"\n{len(failures)} failure(s)" if failures else "\nALL PASSED")
sys.exit(1 if failures else 0)
