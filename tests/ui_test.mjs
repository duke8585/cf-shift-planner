// Headless Chrome UI checks at phone and desktop size. Creates its own plans and deletes them again.
// Usage: node tests/ui_test.mjs <base_url>   (e.g. http://localhost:8787 with `npm run dev` running)
// Chrome path: $CHROME, default is the macOS install.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = (process.argv[2] || "http://localhost:8787").replace(/\/$/, "");
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9334;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];

function check(label, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${label}${cond ? "" : `  -> ${JSON.stringify(detail)}`}`);
  if (!cond) failures.push(label);
}

async function api(method, path, body) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { "content-type": "application/json", "user-agent": "many-hands-ui-test/1.0" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

// One fresh page per call: set viewport + language, load `url`, run `script` in the page, return its value.
async function inPage(send, { url, width, height = 844, lang = "de", script }) {
  const mobile = width < 600;
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
  const added = await send("Page.addScriptToEvaluateOnNewDocument", { source: `localStorage.setItem("shiftPlanner.lang","${lang}")` });
  await send("Page.navigate", { url: "about:blank" });
  await send("Page.navigate", { url });
  await sleep(1500);
  await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: added.result.identifier });
  const res = await send("Runtime.evaluate", { expression: `(async () => { ${script} })()`, awaitPromise: true, returnByValue: true });
  if (res.result.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails));
  return res.result.result.value;
}

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars", `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), "ui-test-"))}`, "about:blank",
], { stdio: "ignore" });

const created = [];
try {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    target = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json()).then((l) => l.find((t) => t.type === "page")).catch(() => null);
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data);
    if (pending.has(msg.id)) pending.get(msg.id)(msg), pending.delete(msg.id);
  });
  const send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
  await send("Page.enable");

  // fixtures: one active plan with shifts, one archived plan
  const { id: planId } = await api("POST", "/plans", { name: "UI test plan" });
  created.push(planId);
  await api("PUT", `/plans/${planId}/shifts`, {
    shifts: [
      { role: "Bar", date: "2026-12-05", startTime: "14:00", endTime: "16:00", capacity: 2 },
      { role: "Grill", date: "2026-12-05", startTime: "14:00", capacity: 1 },
    ],
  });
  const { id: archivedId } = await api("POST", "/plans", { name: "UI test archived" });
  created.push(archivedId);
  await api("POST", `/plans/${archivedId}/archive`, {});

  // toast: uses the full phone width instead of a narrow blob
  const toast = await inPage(send, {
    url: `${BASE}/#/`,
    width: 390,
    script: `toast(t("signedUp","Maria Schmidt","Bar","Fr., 6. Nov.","14:00"),{label:t("undo"),run(){}});
      await new Promise(r=>setTimeout(r,400));
      const r=document.getElementById("toast").getBoundingClientRect(), b=document.querySelector("#toast button").getBoundingClientRect();
      return {left:r.left,right:innerWidth-r.right,height:r.height,btnHeight:b.height};`,
  });
  check("toast spans phone width (1rem gutters)", Math.abs(toast.left - toast.right) < 2 && toast.left <= 20, toast);
  check("toast stays compact on phone", toast.height < 130 && toast.btnHeight < 56, toast);

  // archived link: no stray "undefined"/"false" before or after toggling
  const archived = await inPage(send, {
    url: `${BASE}/#/`,
    width: 390,
    script: `const find=()=>[...document.querySelectorAll("main button")].find(b=>b.textContent.startsWith("Archivierte"));
      const tail=()=>[...document.querySelector("main").childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join("");
      const before={label:find().textContent,tail:tail()};
      find().click(); await new Promise(r=>setTimeout(r,1200));
      return {before,after:{label:find().textContent,tail:tail(),shown:document.querySelector("main").textContent.includes("UI test archived")}};`,
  });
  check("archived link label", /^Archivierte anzeigen \(\d+\)$/.test(archived.before.label), archived);
  check("no stray text before toggle", archived.before.tail.trim() === "", archived);
  check("no stray text after toggle", archived.after.tail.trim() === "" && archived.after.label === "Archivierte ausblenden", archived);
  check("archived plan shown after toggle", archived.after.shown, archived);

  // sign-up cards: role heading, x/y count, no horizontal overflow at 320px
  for (const lang of ["de", "en"]) {
    const signup = await inPage(send, {
      url: `${BASE}/#/plan/${planId}/signup`,
      width: 320,
      lang,
      script: `const li=[...document.querySelectorAll("main li")];
        return {overflow:document.documentElement.scrollWidth-innerWidth,
          heads:li.map(l=>l.querySelector("h3")?.textContent), counts:li.map(l=>l.querySelector("h3")?.nextSibling?.textContent)};`,
    });
    check(`[${lang}] no horizontal overflow at 320px`, signup.overflow <= 0, signup);
    check(`[${lang}] cards show role heading + until`, signup.heads[0]?.startsWith("Bar") && /16:00/.test(signup.heads[0]), signup);
    check(`[${lang}] cards show x/y count`, signup.counts.every((c) => /^\d+\/\d+$/.test(c)), signup);
  }

  // overview headers are plain role names, not chips
  const overview = await inPage(send, {
    url: `${BASE}/#/plan/${planId}/overview`,
    width: 1280,
    script: `return [...document.querySelectorAll("thead th")].slice(1).map(th=>({text:th.textContent,chips:th.querySelectorAll("span").length}));`,
  });
  check("overview headers = role names", overview.map((o) => o.text).join() === "Bar,Grill" && overview.every((o) => !o.chips), overview);

  ws.close();
} catch (err) {
  check("ui test ran", false, String(err));
} finally {
  for (const planId of created) await api("DELETE", `/plans/${planId}`, {}).catch(() => {});
  chrome.kill();
}

console.log(failures.length ? `\n${failures.length} failure(s)` : "\nALL PASSED");
process.exit(failures.length ? 1 : 0);
