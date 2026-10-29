"use strict";

// ---------- state ----------

const TABS = [
  ["signup", "Sign up"],
  ["overview", "Overview"],
  ["builder", "Builder"],
  ["versions", "Versions"],
];

// [dot, soft background, ink] per role, ordered so neighbours contrast strongly.
// Greens and reds are left out: they mean "full" / "open".
const ROLE_PALETTE = [
  ["#3b82f6", "#dbeafe", "#1e40af"], // blue
  ["#f97316", "#ffedd5", "#9a3412"], // orange
  ["#8b5cf6", "#ede9fe", "#5b21b6"], // violet
  ["#eab308", "#fef9c3", "#854d0e"], // yellow
  ["#ec4899", "#fce7f3", "#9d174d"], // pink
  ["#06b6d4", "#cffafe", "#155e75"], // cyan
  ["#78716c", "#f5f5f4", "#44403c"], // stone
  ["#6366f1", "#e0e7ff", "#3730a3"], // indigo
];

const state = {
  planId: null,
  data: null, // GET /plans/:id response
  roleColors: new Map(),
  tab: "signup",
  unlocked: false,
  rows: null, // builder working copy
  versions: null,
  me: getLastName(), // name used for "Sign up" buttons, remembered across visits
  onlyOpen: false,
  passwords: new Map(), // planId -> admin password, kept in memory for this page load only
  autoUnlock: null, // planId whose builder opens unlocked (right after creating it)
  appVersion: null, // deploy version seen on first API call
};

const app = document.getElementById("app");
document.getElementById("modal-cancel").addEventListener("click", () => document.getElementById("modal").close());

// ---------- helpers ----------

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key === "class") el.className = value;
    else if (key === "value") el.value = value;
    else if (key === "checked") el.checked = value;
    else el.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

async function api(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  checkVersion(res.headers.get("x-app-version"));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// A tab opened before a deploy keeps running old code (hash routing never reloads), so offer a reload.
function checkVersion(version) {
  if (!version) return;
  if (!state.appVersion) state.appVersion = version;
  else if (version !== state.appVersion) document.getElementById("update-banner").hidden = false;
}

function parseDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function fmtDate(iso) {
  return parseDate(iso).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

function fmtDayLong(iso) {
  return parseDate(iso).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
}

function fmtDayShort(iso) {
  return parseDate(iso).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

function fmtWhen(iso) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function getLastName() {
  try {
    return localStorage.getItem("shiftPlanner.name") || "";
  } catch {
    return "";
  }
}

function setLastName(name) {
  try {
    localStorage.setItem("shiftPlanner.name", name);
  } catch {
    /* storage unavailable, ignore */
  }
}

function hash(text) {
  let x = 0;
  for (const c of text.toLowerCase()) x = (x * 31 + c.codePointAt(0)) >>> 0;
  return x;
}

// Roles get palette colors in order of first appearance (= builder row order), so the first
// few roles in a plan are always clearly distinct. Duplicated plans keep the same colors.
function computeRoleColors(roles) {
  return new Map([...new Set(roles)].map((role, i) => [role, ROLE_PALETTE[i % ROLE_PALETTE.length]]));
}

function roleStyle(role, colors = state.roleColors) {
  const [dot, soft, ink] = colors.get(role) || ["#a8a29e", "#f5f5f4", "#44403c"];
  return `--role:${dot};--role-soft:${soft};--role-ink:${ink}`;
}

function roleChip(role) {
  return h("span", { class: "role-chip", style: roleStyle(role) }, role);
}

let toastTimer;
function toast(message, action) {
  const el = document.getElementById("toast");
  el.replaceChildren(h("span", { class: "font-medium" }, message));
  if (action) {
    el.append(
      h("button", {
        class: "min-h-10 flex-none cursor-pointer rounded-full bg-white px-4 font-bold text-stone-900 hover:bg-stone-200",
        onclick: () => {
          el.hidden = true;
          action.run();
        },
      }, action.label),
    );
  }
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 8000);
}

function showError(err) {
  toast(`⚠️ ${err.message}`);
}

// Password modal. `verify(pw)` should throw on a wrong password; the modal stays open and shows the error.
function askPassword({ title, text, verify }) {
  const dialog = document.getElementById("modal");
  const form = dialog.querySelector("form");
  const input = document.getElementById("modal-input");
  const error = document.getElementById("modal-error");
  document.getElementById("modal-title").textContent = title;
  document.getElementById("modal-text").textContent = text;
  input.value = "";
  error.hidden = true;

  return new Promise((resolve) => {
    const onSubmit = async (e) => {
      e.preventDefault();
      const pw = input.value;
      if (!pw) return;
      try {
        if (verify) await verify(pw);
        cleanup();
        dialog.close();
        resolve(pw);
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
        input.select();
      }
    };
    const onClose = () => {
      cleanup();
      resolve(null);
    };
    const cleanup = () => {
      form.removeEventListener("submit", onSubmit);
      dialog.removeEventListener("close", onClose);
    };
    form.addEventListener("submit", onSubmit);
    dialog.addEventListener("close", onClose);
    dialog.showModal();
    input.focus();
  });
}

// Returns the admin password to send (or "" if the plan has none), or null if the user cancelled.
async function adminAuth(plan, confirmText) {
  if (!plan.hasAdminPassword) return confirm(confirmText) ? "" : null;
  const known = state.passwords.get(plan.id);
  if (known) return confirm(confirmText) ? known : null;
  const pw = await askPassword({
    title: "Admin password",
    text: confirmText,
    verify: (p) => api("POST", `/plans/${plan.id}/verify`, { adminPassword: p }),
  });
  if (pw) state.passwords.set(plan.id, pw);
  return pw;
}

function emptyCard(text) {
  return h("div", { class: "card py-14 text-center text-lg text-stone-600" }, text);
}

// ---------- routing ----------

function route() {
  const [, page, id, tab] = location.hash.replace(/^#/, "").split("/");
  if (page === "plan" && id) {
    if (id !== state.planId) {
      Object.assign(state, { planId: id, data: null, unlocked: false, rows: null, versions: null });
    }
    state.tab = TABS.some(([key]) => key === tab) ? tab : "signup";
    renderPlan();
  } else {
    state.planId = null;
    renderHome();
  }
  window.scrollTo({ top: 0, behavior: "instant" });
}

window.addEventListener("hashchange", route);
route();

// Keep sign-up / overview fresh while several people use the plan at once.
setInterval(() => {
  if (document.hidden || !state.planId || !["signup", "overview"].includes(state.tab)) return;
  if (!document.activeElement?.matches("input")) refreshPlan();
}, 30000);
// Print: switch to the print layout at A4-landscape width (277 x 190 mm printable at 10 mm margins),
// measure it and zoom it down so it fits one sheet. If that would go below MIN_PRINT_ZOOM (unreadable),
// print one sheet per day instead, zoomed so the tallest day fits.
const PRINT_W = (277 / 25.4) * 96;
const PRINT_H = (190 / 25.4) * 96;
const MIN_PRINT_ZOOM = 0.45;
window.addEventListener("beforeprint", () => {
  const root = document.documentElement;
  root.classList.add("printing");
  root.classList.remove("print-per-day");
  app.style.zoom = "";
  app.style.width = `${PRINT_W}px`;
  const fitWidth = (PRINT_W / app.scrollWidth) * 0.98;
  let zoom = Math.min(1, fitWidth, (PRINT_H / app.scrollHeight) * 0.97);

  const dayRows = [...app.querySelectorAll("tr.day-row")];
  if (zoom < MIN_PRINT_ZOOM && dayRows.length > 1) {
    root.classList.add("print-per-day");
    const top = app.getBoundingClientRect().top;
    const head = app.querySelector("thead").getBoundingClientRect();
    const tableBottom = app.querySelector("table").getBoundingClientRect().bottom;
    const tallest = Math.max(
      ...dayRows.map((row, i) => {
        const start = row.getBoundingClientRect().top;
        const end = dayRows[i + 1]?.getBoundingClientRect().top ?? tableBottom;
        return (i === 0 ? start - top : head.height) + (end - start); // first sheet also carries the title
      }),
    );
    zoom = Math.min(1, fitWidth, (PRINT_H / tallest) * 0.97);
  }
  zoom = Math.max(MIN_PRINT_ZOOM, zoom);
  app.style.zoom = String(zoom);
  app.style.width = `${PRINT_W / zoom}px`; // use the full sheet width at the reduced size
});
window.addEventListener("afterprint", () => {
  document.documentElement.classList.remove("printing", "print-per-day");
  app.style.zoom = "";
  app.style.width = "";
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && state.planId && state.tab !== "builder") refreshPlan();
});

// ---------- home ----------

async function renderHome() {
  document.title = "Shift Planner";
  const nameInput = h("input", { class: "input", placeholder: "e.g. Summer Festival 2026", required: true, maxlength: 200 });
  const pwInput = h("input", { class: "input", type: "password", placeholder: "Optional", autocomplete: "new-password" });
  const list = h("div", { class: "grid gap-4 sm:grid-cols-2" }, h("p", { class: "text-stone-500" }, "Loading…"));

  app.replaceChildren(
    h("h1", { class: "text-3xl font-bold tracking-tight sm:text-4xl" }, "Shift plans"),
    h("p", { class: "mt-2 text-lg text-stone-600" }, "Create a plan, build the shift layout, then share the link so people can sign up."),
    h("form", {
      class: "card mt-6 grid items-end gap-4 sm:grid-cols-[1fr_1fr_auto]",
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          const { id } = await api("POST", "/plans", { name: nameInput.value, adminPassword: pwInput.value || undefined });
          if (pwInput.value) state.passwords.set(id, pwInput.value);
          state.autoUnlock = id;
          location.hash = `#/plan/${id}/builder`;
        } catch (err) {
          showError(err);
        }
      },
    },
      h("label", { class: "label" }, "Plan name", nameInput),
      h("label", { class: "label" }, "Admin password", pwInput),
      h("button", { class: "btn btn-primary" }, "Create plan"),
    ),
    h("h2", { class: "mt-12 mb-4 text-2xl font-bold tracking-tight" }, "Existing plans"),
    list,
  );

  try {
    const { plans } = await api("GET", "/plans");
    list.replaceChildren(...(plans.length ? plans.map(planCard) : [h("p", { class: "text-stone-500" }, "No plans yet.")]));
  } catch (err) {
    list.replaceChildren(h("p", { class: "font-semibold text-rose-700" }, err.message));
  }
}

function planCard(plan) {
  return h("div", { class: "card flex flex-col gap-4" },
    h("div", null,
      h("a", { class: "text-xl font-bold tracking-tight hover:text-orange-700", href: `#/plan/${plan.id}` }, plan.name, plan.has_admin_password ? " 🔒" : ""),
      h("p", { class: "mt-1 text-base text-stone-500" }, `Created ${fmtWhen(plan.created_at)}`),
    ),
    h("div", { class: "mt-auto flex flex-wrap gap-2" },
      h("a", { class: "btn btn-sm btn-primary", href: `#/plan/${plan.id}` }, "Open"),
      h("button", {
        class: "btn btn-sm",
        onclick: async () => {
          const name = prompt("Name for the copy:", `${plan.name} (copy)`);
          if (name === null) return;
          try {
            await api("POST", `/plans/${plan.id}/duplicate`, { name });
            toast("Plan duplicated (shifts only, no sign-ups)");
            renderHome();
          } catch (err) {
            showError(err);
          }
        },
      }, "Duplicate"),
      h("button", {
        class: "btn btn-sm btn-danger",
        onclick: async () => {
          const pw = await adminAuth(
            { id: plan.id, hasAdminPassword: !!plan.has_admin_password },
            `Delete "${plan.name}" with all shifts, sign-ups and versions? This cannot be undone.`,
          );
          if (pw === null) return;
          try {
            await api("DELETE", `/plans/${plan.id}`, { adminPassword: pw || undefined });
            toast("Plan deleted");
            renderHome();
          } catch (err) {
            showError(err);
          }
        },
      }, "Delete"),
    ),
  );
}

// ---------- plan view ----------

async function refreshPlan() {
  try {
    state.data = await api("GET", `/plans/${state.planId}`);
    state.roleColors = computeRoleColors(state.data.shifts.map((s) => s.role));
  } catch (err) {
    if (err.status === 404) {
      state.data = null;
      app.replaceChildren(
        h("h1", { class: "text-3xl font-bold" }, "Plan not found"),
        h("a", { class: "mt-4 inline-block font-semibold text-orange-700", href: "#/" }, "← All plans"),
      );
      return;
    }
    showError(err);
    return;
  }
  renderPlan();
}

function renderPlan() {
  if (!state.data) {
    app.replaceChildren(h("p", { class: "text-stone-500" }, "Loading…"));
    refreshPlan();
    return;
  }
  const { plan } = state.data;
  document.title = `${plan.name} · Shift Planner`;

  if (state.autoUnlock === plan.id) {
    state.autoUnlock = null;
    openBuilder();
  }

  const body = h("div");
  app.replaceChildren(
    h("a", { class: "no-print inline-flex min-h-10 items-center text-base font-semibold text-stone-600 hover:text-stone-900", href: "#/" }, "← All plans"),
    h("h1", { class: "mt-1 text-3xl font-bold tracking-tight sm:text-4xl" }, plan.name, plan.hasAdminPassword ? h("span", { class: "no-print" }, " 🔒") : ""),
    h("div", { class: "no-print mt-3 flex flex-wrap items-center gap-3 text-base text-stone-500" },
      `Created ${fmtWhen(plan.createdAt)}`,
      h("button", {
        class: "btn btn-sm",
        onclick: async () => {
          const link = `${location.origin}/#/plan/${plan.id}`;
          try {
            await navigator.clipboard.writeText(link);
            toast("Sign-up link copied");
          } catch {
            prompt("Copy this link:", link);
          }
        },
      }, "Copy share link"),
    ),
    h("nav", { class: "no-print mt-6 mb-8 flex gap-1 overflow-x-auto rounded-full bg-stone-200/70 p-1.5" },
      TABS.map(([key, label]) =>
        h("button", {
          class: state.tab === key
            ? "min-h-11 flex-1 cursor-pointer rounded-full bg-white px-4 font-semibold whitespace-nowrap text-stone-900 shadow-sm"
            : "min-h-11 flex-1 cursor-pointer rounded-full px-4 font-semibold whitespace-nowrap text-stone-600 hover:text-stone-900",
          "aria-current": state.tab === key ? "page" : null,
          onclick: () => (location.hash = `#/plan/${plan.id}/${key}`),
        }, label),
      ),
    ),
    body,
  );

  if (state.tab === "signup") body.append(renderSignupList());
  else if (state.tab === "overview") body.append(renderMatrix());
  else if (state.tab === "builder") body.append(renderBuilder());
  else renderVersions(body);
}

// ---------- shared bits ----------

function gridModel(shifts) {
  const roles = [];
  const slots = new Map(); // "date|time" -> { date, time }
  const byKey = new Map();
  for (const s of shifts) {
    if (!roles.includes(s.role)) roles.push(s.role);
    slots.set(`${s.date}|${s.startTime}`, { date: s.date, time: s.startTime });
    const key = `${s.role}|${s.date}|${s.startTime}`;
    if (!byKey.has(key)) byKey.set(key, s);
  }
  const sorted = [...slots.values()].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  return { roles, slots: sorted, byKey };
}

function signupsByShift() {
  const byShift = new Map(state.data.shifts.map((s) => [s.id, []]));
  for (const u of state.data.signups) byShift.get(u.shiftId)?.push(u);
  return byShift;
}

function progressSummary(shifts, byShift) {
  const total = shifts.reduce((n, s) => n + s.capacity, 0);
  const filled = shifts.reduce((n, s) => n + Math.min(byShift.get(s.id).length, s.capacity), 0);
  return h("div", { class: "flex flex-col gap-2.5" },
    h("div", { class: "flex flex-wrap items-baseline gap-x-2 text-lg" },
      h("span", { class: "font-bold" }, `${filled} of ${total} spots filled`),
      total > filled
        ? h("span", { class: "font-semibold text-rose-700" }, `· ${total - filled} still open`)
        : h("span", { class: "font-semibold text-emerald-700" }, "· all covered 🎉"),
    ),
    h("div", { class: "h-2.5 overflow-hidden rounded-full bg-stone-200", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": total, "aria-valuenow": filled },
      h("div", { class: "h-full rounded-full bg-emerald-500 transition-all", style: `width:${total ? (filled / total) * 100 : 0}%` }),
    ),
  );
}

function initials(name) {
  const parts = name.split(/\s+/).filter((p) => /^\p{L}/u.test(p)); // skip "(Nachbarin)" etc.
  if (!parts.length) return name.trim().slice(0, 1).toUpperCase();
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

// Name pill with a colored initial avatar; `onRemove` adds the × button.
function pill(name, onRemove) {
  const me = state.me.trim().toLowerCase();
  const isMe = me && name.toLowerCase() === me;
  return h("span", {
    class: `pill${onRemove ? "" : " pill-static"}${isMe ? " pill-me" : ""}`,
    style: `--h:${hash(name) % 360}`,
    "data-name": name.toLowerCase(),
  },
    h("span", { class: "avatar", "aria-hidden": "true" }, initials(name)),
    h("span", { class: "truncate" }, name, isMe ? h("span", { class: "me-tag font-semibold text-stone-500" }, " (you)") : null),
    onRemove && h("button", { class: "pill-x", title: `Remove ${name}`, "aria-label": `Remove ${name}`, onclick: onRemove }, "×"),
  );
}

function markMe() {
  const me = state.me.trim().toLowerCase();
  app.querySelectorAll(".pill").forEach((p) => {
    const isMe = !!me && p.dataset.name === me;
    p.classList.toggle("pill-me", isMe);
    const label = p.querySelector(".truncate");
    const tag = label.querySelector(".me-tag");
    if (isMe && !tag) label.append(h("span", { class: "me-tag font-semibold text-stone-500" }, " (you)"));
    if (!isMe && tag) tag.remove();
  });
}

// ---------- sign-up list ----------

function renderSignupList() {
  const { shifts } = state.data;
  if (!shifts.length) return emptyCard("No shifts yet. The organizer can add them in the Builder tab.");

  const byShift = signupsByShift();
  const isFull = (s) => byShift.get(s.id).length >= s.capacity;
  const openIn = (list) => list.reduce((n, s) => n + Math.max(0, s.capacity - byShift.get(s.id).length), 0);

  // date -> start time -> shifts, roles in builder order
  const { roles } = gridModel(shifts);
  const ordered = [...shifts].sort(
    (a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime) || roles.indexOf(a.role) - roles.indexOf(b.role),
  );
  const days = new Map();
  for (const s of ordered) {
    if (!days.has(s.date)) days.set(s.date, new Map());
    const slots = days.get(s.date);
    if (!slots.has(s.startTime)) slots.set(s.startTime, []);
    slots.get(s.startTime).push(s);
  }

  const jump = [];
  const sections = [];
  for (const [date, slots] of days) {
    const open = openIn([...slots.values()].flat());
    const slotEls = [];
    for (const [time, list] of slots) {
      const visible = state.onlyOpen ? list.filter((s) => !isFull(s)) : list;
      if (!visible.length) continue;
      // Show the end under the start time when the whole slot shares it, otherwise per shift.
      const ends = new Set(list.map((s) => s.endTime || ""));
      const sharedEnd = ends.size === 1 ? [...ends][0] : "";
      slotEls.push(
        h("div", { class: "grid gap-x-6 gap-y-3 border-t border-dashed border-stone-300 py-6 first:border-t-0 sm:grid-cols-[6.5rem_1fr]" },
          h("div", { class: "text-2xl font-bold tracking-tight tabular-nums sm:pt-4" },
            time,
            sharedEnd && h("span", { class: "ml-2 text-lg font-semibold text-stone-500 sm:ml-0 sm:block" }, `to ${sharedEnd}`),
          ),
          h("ul", { class: "flex flex-col gap-3" }, visible.map((s) => shiftItem(s, byShift.get(s.id), !sharedEnd))),
        ),
      );
    }
    if (!slotEls.length) continue;
    const id = `day-${date}`;
    jump.push(
      h("button", { class: "btn btn-sm", onclick: () => document.getElementById(id)?.scrollIntoView() },
        fmtDayShort(date),
        open
          ? h("span", { class: "badge bg-rose-100 text-rose-800" }, `${open} open`)
          : h("span", { class: "badge bg-emerald-100 text-emerald-800" }, "✓ full"),
      ),
    );
    sections.push(
      h("section", { class: "mt-10 scroll-mt-24", id },
        h("h2", { class: "flex flex-wrap items-baseline justify-between gap-3 border-b-2 border-stone-200 pb-3 text-2xl font-bold tracking-tight" },
          fmtDayLong(date),
          h("span", { class: open ? "text-base font-semibold text-rose-700" : "text-base font-semibold text-emerald-700" },
            open ? `${open} spots open` : "All filled ✓"),
        ),
        slotEls,
      ),
    );
  }

  const meInput = h("input", {
    id: "me",
    class: "input min-h-14 text-xl",
    value: state.me,
    placeholder: "e.g. Maria Schmidt",
    maxlength: 100,
    autocomplete: "name",
    oninput: (e) => {
      state.me = e.target.value;
      setLastName(state.me.trim());
      markMe();
    },
  });

  return h("div", null,
    h("section", { class: "card flex flex-col gap-3" },
      h("label", { for: "me", class: "text-lg font-bold" }, "Your name"),
      meInput,
      h("p", { class: "text-base text-stone-600" }, "Type your name once, then tap “Sign up” next to any shift. Tap × on a name to remove it."),
      h("label", { class: "flex min-h-11 cursor-pointer items-center gap-3 font-medium" },
        h("input", { type: "checkbox", class: "size-6 flex-none", checked: state.onlyOpen, onchange: (e) => ((state.onlyOpen = e.target.checked), renderPlan()) }),
        "Only show shifts with open spots",
      ),
    ),
    h("div", { class: "mt-8" }, progressSummary(shifts, byShift)),
    jump.length > 1 && h("nav", { class: "mt-5 flex flex-wrap gap-2", "aria-label": "Jump to day" }, jump),
    sections.length ? sections : h("div", { class: "mt-8" }, emptyCard("🎉 Every shift is filled.")),
  );
}

function shiftItem(shift, people, showEnd) {
  const left = shift.capacity - people.length;
  const full = left <= 0;
  const status = full
    ? h("span", { class: "badge bg-emerald-100 text-emerald-800" }, "✓ Full")
    : people.length
      ? h("span", { class: "badge bg-amber-100 text-amber-900" }, `${left} of ${shift.capacity} spots left`)
      : h("span", { class: "badge bg-rose-100 text-rose-800" }, `${shift.capacity} ${shift.capacity === 1 ? "spot" : "spots"} open`);
  return h("li", {
    class: full
      ? "relative flex flex-wrap items-center justify-between gap-4 overflow-hidden rounded-3xl bg-emerald-50 py-5 pr-5 pl-7 ring-1 ring-emerald-200"
      : "relative flex flex-wrap items-center justify-between gap-4 overflow-hidden rounded-3xl bg-white py-5 pr-5 pl-7 shadow-sm ring-1 ring-stone-200/80",
    style: roleStyle(shift.role),
  },
    h("span", { class: "absolute inset-y-0 left-0 w-2 bg-(--role)", "aria-hidden": "true" }),
    h("div", { class: "flex min-w-0 flex-1 basis-72 flex-col gap-3" },
      h("div", { class: "flex flex-wrap items-center gap-2" },
        roleChip(shift.role),
        showEnd && shift.endTime && h("span", { class: "font-semibold text-stone-500" }, `until ${shift.endTime}`),
        status,
      ),
      people.length
        ? h("div", { class: "flex flex-wrap gap-2" }, people.map((u) => pill(u.name, () => removeSignup(shift, u))))
        : h("span", { class: "text-base text-stone-500 italic" }, "No one yet"),
    ),
    !full && h("button", { class: "btn btn-primary min-w-36 text-lg max-sm:w-full", onclick: () => signUpMe(shift, people) }, "Sign up"),
  );
}

function signUpMe(shift, people) {
  const name = state.me.trim();
  if (!name) {
    const input = document.getElementById("me");
    input.scrollIntoView({ block: "center" });
    input.focus();
    input.classList.remove("nudge");
    void input.offsetWidth; // restart the nudge animation
    input.classList.add("nudge");
    toast("Please type your name first");
    return;
  }
  if (people.some((u) => u.name.toLowerCase() === name.toLowerCase())) {
    toast(`${name} is already signed up here`);
    return;
  }
  addSignup(shift, name);
}

async function addSignup(shift, name) {
  try {
    const { id } = await api("POST", `/plans/${state.planId}/shifts/${shift.id}/signup`, { name });
    await refreshPlan();
    toast(`✓ ${name} signed up: ${shift.role}, ${fmtDayShort(shift.date)} ${shift.startTime}`, {
      label: "Undo",
      run: async () => {
        try {
          await api("DELETE", `/plans/${state.planId}/signups/${id}`);
          await refreshPlan();
          toast("Sign-up undone");
        } catch (err) {
          showError(err);
        }
      },
    });
  } catch (err) {
    showError(err);
    if (err.status === 409 || err.status === 404) refreshPlan();
  }
}

async function removeSignup(shift, signup) {
  try {
    await api("DELETE", `/plans/${state.planId}/signups/${signup.id}`);
    await refreshPlan();
    toast(`Removed ${signup.name} from ${shift.role}`, {
      label: "Undo",
      run: () => addSignup(shift, signup.name),
    });
  } catch (err) {
    showError(err);
    refreshPlan();
  }
}

// ---------- overview matrix (also the print view) ----------

function renderMatrix() {
  const { shifts } = state.data;
  if (!shifts.length) return emptyCard("No shifts yet. The organizer can add them in the Builder tab.");

  const byShift = signupsByShift();
  const { roles, slots, byKey } = gridModel(shifts);
  const timesByDate = new Map();
  for (const { date, time } of slots) timesByDate.set(date, [...(timesByDate.get(date) || []), time]);
  const covered = new Set();

  const rows = [];
  let lastDate = null;
  for (const slot of slots) {
    if (slot.date !== lastDate) {
      lastDate = slot.date;
      rows.push(
        h("tr", { class: "day-row" },
          h("th", { colspan: roles.length + 1, class: "border-b border-stone-200 bg-stone-100 px-4 py-2.5 text-left text-lg font-bold" }, fmtDate(slot.date)),
        ),
      );
    }
    rows.push(
      h("tr", null,
        h("td", { class: "w-px border-b border-stone-100 px-4 py-3 align-top text-lg font-bold whitespace-nowrap tabular-nums" }, slot.time),
        roles.map((role) => {
          const key = `${role}|${slot.date}|${slot.time}`;
          if (covered.has(key)) return null;
          const shift = byKey.get(key);
          if (!shift) return h("td", { class: "hatch border-b border-l border-stone-100" });
          // A shift with an end time stretches down over the rows it covers,
          // stopping early if the same role has another shift starting there.
          let span = 1;
          if (shift.endTime) {
            for (const t of timesByDate.get(slot.date)) {
              if (t <= slot.time) continue;
              const next = `${role}|${slot.date}|${t}`;
              if ((shift.endTime > shift.startTime && t >= shift.endTime) || byKey.has(next)) break;
              covered.add(next);
              span++;
            }
          }
          return overviewCell(shift, byShift.get(shift.id), span);
        }),
      ),
    );
  }

  return h("div", { class: "flex flex-col gap-6" },
    h("div", { class: "flex flex-wrap items-end justify-between gap-4" },
      h("div", { class: "min-w-64 flex-1" }, progressSummary(shifts, byShift)),
      h("button", { class: "no-print btn", onclick: () => window.print() }, "🖨️ Print"),
    ),
    h("div", { class: "flex flex-wrap gap-x-5 gap-y-2 text-base text-stone-600" },
      [["bg-emerald-100 ring-emerald-300", "Full"], ["bg-orange-100 ring-orange-300", "Partly filled"], ["bg-red-200 ring-red-300", "Nobody yet"]].map(([cls, label]) =>
        h("span", { class: "inline-flex items-center gap-2" }, h("span", { class: `size-4 rounded ring-1 ${cls}` }), label),
      ),
    ),
    h("div", { class: "print-wrap overflow-x-auto rounded-3xl bg-white shadow-sm ring-1 ring-stone-200/80" },
      h("table", { class: "w-full border-collapse text-left" },
        h("thead", null,
          h("tr", null,
            h("th", { class: "border-b border-stone-200 px-4 py-3 text-base font-semibold text-stone-500" }, "Time"),
            roles.map((r) =>
              h("th", { class: "border-b border-l border-stone-200 border-t-4 border-t-(--role) px-3 py-3", style: roleStyle(r) }, roleChip(r)),
            ),
          ),
        ),
        h("tbody", null, rows),
      ),
    ),
  );
}

function overviewCell(shift, people, span) {
  const open = shift.capacity - people.length;
  const rowspan = span > 1 ? span : null;
  const range = rowspan && h("div", { class: "mb-1.5 text-sm font-semibold text-stone-500 tabular-nums" }, `${shift.startTime}–${shift.endTime}`);
  const base = "min-w-44 border-b border-l border-stone-100 px-3 py-3 align-top shadow-[inset_4px_0_0_var(--role)]";
  if (!people.length) {
    return h("td", { class: `${base} bg-red-200`, rowspan, style: roleStyle(shift.role) },
      range,
      h("span", { class: "font-bold text-red-900" }, `(${open} open)`),
    );
  }
  return h("td", { class: open <= 0 ? `${base} bg-emerald-50` : `${base} bg-orange-100`, rowspan, style: roleStyle(shift.role) },
    range,
    h("div", { class: "pills flex flex-wrap gap-1.5" }, people.map((u) => pill(u.name))),
    open > 0 && h("div", { class: "mt-1.5 text-sm font-bold text-orange-800" }, `(${open} open)`),
  );
}

// ---------- builder ----------

async function unlockBuilder() {
  const { plan, shifts } = state.data;
  if (plan.hasAdminPassword) {
    if (!state.passwords.has(plan.id) && (await adminAuth(plan, "Enter the admin password to edit the layout.")) === null) return;
  } else if (shifts.length && !confirm("Edit the shift layout? Changes affect everyone signing up.")) {
    return;
  }
  openBuilder();
  renderPlan();
}

function layoutFields({ id, role, date, startTime, endTime, capacity }) {
  return { id, role, date, startTime, endTime: endTime || null, capacity };
}

function openBuilder() {
  state.unlocked = true;
  state.rows = state.data.shifts.map(layoutFields);
}

function renderBuilder() {
  if (!state.unlocked) {
    return h("div", { class: "card flex flex-col items-center gap-3 py-14 text-center" },
      h("div", { class: "grid size-16 place-items-center rounded-full bg-stone-100 text-3xl" }, "🔒"),
      h("h2", { class: "text-2xl font-bold tracking-tight" }, "Layout is locked"),
      h("p", { class: "max-w-md text-stone-600" }, "The shift structure is locked so it can't be changed by accident."),
      h("button", { class: "btn btn-primary mt-2", onclick: unlockBuilder }, "Edit layout"),
    );
  }
  const tbody = h("tbody");
  const counter = h("span", { class: "text-stone-500" });
  const redraw = () => {
    const colors = computeRoleColors(state.rows.map((r) => (r.role || "").trim()).filter(Boolean));
    tbody.replaceChildren(...state.rows.map((row, i) => builderRow(row, i, redraw, colors)));
    counter.textContent = `${state.rows.length} rows`;
  };
  redraw();

  return h("div", { class: "flex flex-col gap-5" },
    h("div", { class: "flex flex-wrap items-center gap-3" },
      h("button", { class: "btn btn-primary", onclick: saveLayout }, "Save layout"),
      h("button", { class: "btn", onclick: cancelBuilder }, "Cancel"),
      h("span", { class: "flex-1" }),
      counter,
    ),
    quickGenerate(redraw),
    h("div", { class: "overflow-x-auto rounded-3xl bg-white shadow-sm ring-1 ring-stone-200/80" },
      h("table", { class: "w-full border-collapse text-left" },
        h("thead", null,
          h("tr", null,
            ["Role", "Date", "Start", "End", "Spots", "", ""].map((t) =>
              h("th", { class: "px-3 pt-4 pb-2 text-sm font-semibold tracking-wide text-stone-500 uppercase" }, t),
            ),
          ),
        ),
        tbody,
      ),
    ),
    h("div", null,
      h("button", {
        class: "btn",
        onclick: () => {
          const last = state.rows[state.rows.length - 1];
          state.rows.push(last ? { ...last, id: undefined } : { role: "", date: "", startTime: "", endTime: "", capacity: 1 });
          redraw();
        },
      }, "+ Add row"),
    ),
  );
}

function builderRow(row, i, redraw, colors) {
  const bind = (field, props) =>
    h("input", {
      class: "input min-h-11 text-base",
      ...props,
      value: row[field] ?? "",
      oninput: (e) => (row[field] = props.type === "number" ? Number(e.target.value) : e.target.value),
    });
  const signupCount = row.id ? state.data.signups.filter((u) => u.shiftId === row.id).length : 0;
  const role = (row.role || "").trim();
  return h("tr", { class: row.dupe ? "bg-rose-50" : "", style: role ? roleStyle(role, colors) : null },
    h("td", { class: "border-t border-stone-100 py-2 pr-2 pl-4" },
      h("div", { class: "flex items-center gap-2.5" },
        h("span", { class: role ? "size-3.5 flex-none rounded-full bg-(--role)" : "size-3.5 flex-none rounded-full bg-stone-200", "aria-hidden": "true" }),
        h("input", {
          class: "input min-h-11 min-w-32 text-base font-semibold",
          placeholder: "Role",
          maxlength: 100,
          value: row.role ?? "",
          oninput: (e) => (row.role = e.target.value),
          onchange: redraw, // recolor once the name is final
        }),
      ),
    ),
    h("td", { class: "border-t border-stone-100 p-2" }, bind("date", { type: "date" })),
    h("td", { class: "border-t border-stone-100 p-2" }, bind("startTime", { type: "time", "aria-label": "Start" })),
    h("td", { class: "border-t border-stone-100 p-2" }, bind("endTime", { type: "time", "aria-label": "End (optional)" })),
    h("td", { class: "border-t border-stone-100 p-2" }, bind("capacity", { type: "number", min: 1, max: 1000, class: "input min-h-11 w-20 text-base" })),
    h("td", { class: "border-t border-stone-100 p-2 text-sm font-semibold whitespace-nowrap text-stone-500" }, signupCount ? `${signupCount} signed up` : ""),
    h("td", { class: "border-t border-stone-100 py-2 pr-4 pl-2 whitespace-nowrap" },
      h("div", { class: "flex gap-1.5" },
        h("button", {
          class: "btn btn-sm px-3",
          title: "Duplicate row",
          "aria-label": "Duplicate row",
          onclick: () => {
            state.rows.splice(i + 1, 0, { ...row, id: undefined, dupe: false });
            redraw();
          },
        }, "⧉"),
        h("button", {
          class: "btn btn-sm btn-danger px-3",
          title: "Delete row",
          "aria-label": "Delete row",
          onclick: () => {
            state.rows.splice(i, 1);
            redraw();
          },
        }, "🗑"),
      ),
    ),
  );
}

function quickGenerate(redraw) {
  const today = new Date().toISOString().slice(0, 10);
  const f = {
    role: h("input", { class: "input", placeholder: "e.g. Bar" }),
    from: h("input", { class: "input", type: "date", value: today }),
    to: h("input", { class: "input", type: "date", value: today }),
    start: h("input", { class: "input", type: "time", value: "14:00" }),
    end: h("input", { class: "input", type: "time", value: "22:00" }),
    hours: h("input", { class: "input", type: "number", value: 2, min: 0.25, step: 0.25 }),
    cap: h("input", { class: "input", type: "number", value: 1, min: 1 }),
  };
  const field = (label, input) => h("label", { class: "label" }, label, input);

  const generate = (e) => {
    e.preventDefault();
    const role = f.role.value.trim();
    const step = Math.round(Number(f.hours.value) * 60);
    const cap = Number(f.cap.value);
    const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
    const startMin = toMin(f.start.value || "00:00");
    const endMin = toMin(f.end.value || "00:00");
    if (!role || !f.from.value || !f.to.value) return alert("Role and dates are required.");
    if (f.to.value < f.from.value) return alert("'Date to' must be on or after 'Date from'.");
    if (endMin <= startMin) return alert("End time must be after start time (same day).");
    if (!(step > 0) || !Number.isInteger(cap) || cap < 1) return alert("Slot length and spots must be positive.");

    const dates = [];
    for (let d = new Date(`${f.from.value}T00:00:00Z`); d <= new Date(`${f.to.value}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
      dates.push(d.toISOString().slice(0, 10));
    }
    const hhmm = (t) => `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
    const times = [];
    for (let t = startMin; t + step <= endMin; t += step) times.push([hhmm(t), hhmm(t + step)]);
    if (!times.length) return alert("The slot length is longer than the time window.");
    const count = dates.length * times.length;
    if (count > 300 && !confirm(`This generates ${count} rows. Continue?`)) return;
    for (const date of dates) {
      for (const [startTime, endTime] of times) state.rows.push({ role, date, startTime, endTime, capacity: cap });
    }
    redraw();
    toast(`Added ${count} rows (${dates.length} days × ${times.length} slots)`);
  };

  return h("details", { class: "card group", open: state.rows.length === 0 },
    h("summary", { class: "flex cursor-pointer list-none items-center justify-between gap-3 text-lg font-bold" },
      h("span", null, "⚡ Quick generate"),
      h("span", { class: "text-base font-semibold text-stone-500 group-open:hidden" }, "Show"),
    ),
    h("p", { class: "mt-2 text-base text-stone-600" }, "Creates one row per day and time slot, e.g. Bar from 14:00 to 22:00 in 2-hour slots gives 14–16, 16–18, 18–20, 20–22."),
    h("form", { class: "mt-5 grid grid-cols-2 items-end gap-4 sm:grid-cols-4", onsubmit: generate },
      h("div", { class: "col-span-2" }, field("Role", f.role)),
      field("Date from", f.from),
      field("Date to", f.to),
      field("Start time", f.start),
      field("End time", f.end),
      field("Slot length (hours)", f.hours),
      field("Spots per slot", f.cap),
      h("button", { class: "btn btn-primary col-span-2 sm:col-span-4 sm:justify-self-start" }, "Generate rows"),
    ),
  );
}

async function saveLayout() {
  const rows = state.rows;
  const seen = new Map();
  let dupes = 0;
  rows.forEach((r, i) => {
    r.role = (r.role || "").trim();
    const key = `${r.role}|${r.date}|${r.startTime}`;
    r.dupe = seen.has(key);
    if (r.dupe) {
      dupes++;
      rows[seen.get(key)].dupe = true;
    } else seen.set(key, i);
  });
  if (dupes) {
    renderPlan();
    return alert("Some rows have the same role, date and start time (highlighted). Merge them by raising the spots instead.");
  }
  if (rows.some((r) => !r.role || !r.date || !r.startTime)) return alert("Every row needs a role, date and start time.");

  const keptIds = new Set(rows.map((r) => r.id).filter(Boolean));
  const lost = state.data.signups.filter((u) => !keptIds.has(u.shiftId));
  if (lost.length && !confirm(`Deleted rows have ${lost.length} sign-up(s) that will be removed too. Save anyway?`)) return;

  try {
    await api("PUT", `/plans/${state.planId}/shifts`, {
      shifts: rows.map(layoutFields),
      adminPassword: state.passwords.get(state.planId),
    });
    state.unlocked = false;
    state.rows = null;
    state.versions = null;
    toast("Layout saved");
    await refreshPlan();
    location.hash = `#/plan/${state.planId}/signup`;
  } catch (err) {
    showError(err);
  }
}

function cancelBuilder() {
  const original = JSON.stringify(state.data.shifts.map(layoutFields));
  const current = JSON.stringify(state.rows.map(layoutFields));
  if (original !== current && !confirm("Discard your unsaved layout changes?")) return;
  state.unlocked = false;
  state.rows = null;
  renderPlan();
}

// ---------- versions ----------

async function renderVersions(container) {
  container.replaceChildren(h("p", { class: "text-stone-500" }, "Loading…"));
  try {
    const { versions } = await api("GET", `/plans/${state.planId}/versions`);
    state.versions = versions;
  } catch (err) {
    container.replaceChildren(h("p", { class: "font-semibold text-rose-700" }, err.message));
    return;
  }
  const latest = state.versions[0]?.version_number;
  container.replaceChildren(
    h("p", { class: "mb-5 text-stone-600" }, "Every change is saved as a version (last 100 kept). Restoring creates a new version, so it can be undone too."),
    h("div", { class: "overflow-x-auto rounded-3xl bg-white shadow-sm ring-1 ring-stone-200/80" },
      h("table", { class: "w-full border-collapse text-left" },
        h("thead", null,
          h("tr", null, ["#", "When", "Change", ""].map((t) => h("th", { class: "px-4 pt-4 pb-2 text-sm font-semibold tracking-wide text-stone-500 uppercase" }, t))),
        ),
        h("tbody", null,
          state.versions.map((v) =>
            h("tr", null,
              h("td", { class: "border-t border-stone-100 px-4 py-3 font-semibold text-stone-500 tabular-nums" }, v.version_number),
              h("td", { class: "border-t border-stone-100 px-4 py-3 whitespace-nowrap" }, fmtWhen(v.created_at)),
              h("td", { class: "border-t border-stone-100 px-4 py-3" }, v.description),
              h("td", { class: "border-t border-stone-100 px-4 py-3 text-right" },
                v.version_number === latest
                  ? h("span", { class: "badge bg-stone-100 text-stone-600" }, "current")
                  : h("button", { class: "btn btn-sm", onclick: () => restoreVersion(v.version_number) }, "Restore"),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

async function restoreVersion(n) {
  const pw = await adminAuth(state.data.plan, `Restore version #${n}? Current shifts and sign-ups will be replaced (this itself is versioned).`);
  if (pw === null) return;
  try {
    await api("POST", `/plans/${state.planId}/versions/${n}/restore`, { adminPassword: pw || undefined });
    state.unlocked = false;
    state.rows = null;
    toast(`Restored version #${n}`);
    await refreshPlan();
  } catch (err) {
    showError(err);
  }
}
