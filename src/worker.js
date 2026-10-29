// Shift Planner API. Everything outside /api/* is served from ./public by the assets binding.

const MAX_VERSIONS = 100;
const PBKDF2_ITERATIONS = 100_000; // Workers caps PBKDF2 at 100k
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// Sent with every API response so open tabs notice a new deploy and offer a reload.
let appVersion = "";

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    appVersion = env.CF_VERSION_METADATA?.id || "";
    try {
      return await route(request, env.DB, url.pathname.slice(4).split("/").filter(Boolean));
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: "Internal error" }, 500);
    }
  },
};

async function route(request, db, parts) {
  const m = request.method;
  const [root, planId, sub, subId, action] = parts;
  if (root !== "plans") throw new HttpError(404, "Not found");

  if (parts.length === 1) {
    if (m === "GET") return listPlans(db);
    if (m === "POST") return createPlan(db, await body(request));
  }
  if (parts.length === 2) {
    if (m === "GET") return getPlan(db, planId);
    if (m === "DELETE") return deletePlan(db, planId, await body(request));
  }
  if (parts.length === 3) {
    if (sub === "duplicate" && m === "POST") return duplicatePlan(db, planId, await body(request));
    if (sub === "verify" && m === "POST") return verifyPlan(db, planId, await body(request));
    if (sub === "shifts" && m === "PUT") return saveShifts(db, planId, await body(request));
    if (sub === "versions" && m === "GET") return listVersions(db, planId);
  }
  if (parts.length === 4 && sub === "signups" && m === "DELETE") return removeSignup(db, planId, subId);
  if (parts.length === 5) {
    if (sub === "shifts" && action === "signup" && m === "POST") return signup(db, planId, subId, await body(request));
    if (sub === "versions" && action === "restore" && m === "POST") return restoreVersion(db, planId, subId, await body(request));
  }
  throw new HttpError(404, "Not found");
}

// ---------- handlers ----------

async function listPlans(db) {
  const { results } = await db
    .prepare(
      "SELECT id, name, created_at, updated_at, admin_password_hash IS NOT NULL AS has_admin_password FROM plans ORDER BY created_at DESC",
    )
    .all();
  return json({ plans: results });
}

async function createPlan(db, { name, adminPassword }) {
  name = requireText(name, "Plan name", 200);
  const id = crypto.randomUUID();
  const now = nowIso();
  const hash = adminPassword ? await hashPassword(String(adminPassword)) : null;
  await db
    .prepare("INSERT INTO plans (id, name, admin_password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, name, hash, now, now)
    .run();
  await addVersion(db, id, "Plan created");
  return json({ id }, 201);
}

async function duplicatePlan(db, planId, { name }) {
  const plan = await loadPlan(db, planId);
  const newName = name ? requireText(name, "Plan name", 200) : `${plan.name} (copy)`;
  const id = crypto.randomUUID();
  const now = nowIso();
  const { results: shifts } = await db.prepare("SELECT * FROM shifts WHERE plan_id = ?").bind(planId).all();
  await db.batch([
    db
      .prepare("INSERT INTO plans (id, name, admin_password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .bind(id, newName, plan.admin_password_hash, now, now),
    ...shifts.map((s) => insertShift(db, id, crypto.randomUUID(), s.role, s.date, s.start_time, s.end_time, s.capacity, s.sort_order)),
  ]);
  await addVersion(db, id, `Duplicated from "${plan.name}"`);
  return json({ id }, 201);
}

async function deletePlan(db, planId, { adminPassword }) {
  const plan = await loadPlan(db, planId);
  await requireAdmin(plan, adminPassword);
  await db.batch([
    db.prepare("DELETE FROM signups WHERE shift_id IN (SELECT id FROM shifts WHERE plan_id = ?)").bind(planId),
    db.prepare("DELETE FROM shifts WHERE plan_id = ?").bind(planId),
    db.prepare("DELETE FROM versions WHERE plan_id = ?").bind(planId),
    db.prepare("DELETE FROM plans WHERE id = ?").bind(planId),
  ]);
  return json({ success: true });
}

async function verifyPlan(db, planId, { adminPassword }) {
  await requireAdmin(await loadPlan(db, planId), adminPassword);
  return json({ success: true });
}

async function getPlan(db, planId) {
  const plan = await loadPlan(db, planId);
  const { shifts, signups } = await loadState(db, planId);
  return json({
    plan: { id: plan.id, name: plan.name, hasAdminPassword: !!plan.admin_password_hash, createdAt: plan.created_at },
    shifts: shifts.map((s) => ({
      id: s.id,
      role: s.role,
      date: s.date,
      startTime: s.start_time,
      endTime: s.end_time,
      capacity: s.capacity,
      sortOrder: s.sort_order,
    })),
    signups: signups.map((u) => ({ id: u.id, shiftId: u.shift_id, name: u.name, createdAt: u.created_at })),
  });
}

async function saveShifts(db, planId, { shifts, adminPassword }) {
  const plan = await loadPlan(db, planId);
  await requireAdmin(plan, adminPassword);
  if (!Array.isArray(shifts)) throw new HttpError(400, "shifts must be an array");
  if (shifts.length > 2000) throw new HttpError(400, "Too many shifts");

  const { results: existing } = await db.prepare("SELECT id FROM shifts WHERE plan_id = ?").bind(planId).all();
  const existingIds = new Set(existing.map((r) => r.id));
  const keptIds = new Set();
  const stmts = [];

  shifts.forEach((s, i) => {
    const role = requireText(s.role, "Role", 100);
    if (!DATE_RE.test(s.date || "")) throw new HttpError(400, `Row ${i + 1}: invalid date`);
    if (!TIME_RE.test(s.startTime || "")) throw new HttpError(400, `Row ${i + 1}: invalid start time`);
    const endTime = s.endTime || null;
    if (endTime && !TIME_RE.test(endTime)) throw new HttpError(400, `Row ${i + 1}: invalid end time`);
    const capacity = Number(s.capacity);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 1000) {
      throw new HttpError(400, `Row ${i + 1}: capacity must be a whole number from 1 to 1000`);
    }
    if (s.id && existingIds.has(s.id) && !keptIds.has(s.id)) {
      keptIds.add(s.id);
      stmts.push(
        db
          .prepare(
            "UPDATE shifts SET role = ?, date = ?, start_time = ?, end_time = ?, capacity = ?, sort_order = ? WHERE id = ? AND plan_id = ?",
          )
          .bind(role, s.date, s.startTime, endTime, capacity, i, s.id, planId),
      );
    } else {
      stmts.push(insertShift(db, planId, crypto.randomUUID(), role, s.date, s.startTime, endTime, capacity, i));
    }
  });

  const removed = [...existingIds].filter((id) => !keptIds.has(id));
  for (const id of removed) {
    stmts.unshift(db.prepare("DELETE FROM shifts WHERE id = ?").bind(id));
    stmts.unshift(db.prepare("DELETE FROM signups WHERE shift_id = ?").bind(id));
  }
  if (stmts.length) await db.batch(stmts);
  await addVersion(db, planId, `Layout saved (${shifts.length} shifts)`);
  return json({ success: true });
}

async function signup(db, planId, shiftId, { name }) {
  name = requireText(name, "Name", 100);
  const shift = await db.prepare("SELECT * FROM shifts WHERE id = ? AND plan_id = ?").bind(shiftId, planId).first();
  if (!shift) throw new HttpError(404, "Shift not found");
  const id = crypto.randomUUID();
  // Capacity check and insert in one statement, so concurrent sign-ups can't overfill a shift.
  const res = await db
    .prepare(
      `INSERT INTO signups (id, shift_id, name, created_at)
       SELECT ?, s.id, ?, ? FROM shifts s
       WHERE s.id = ? AND (SELECT COUNT(*) FROM signups WHERE shift_id = s.id) < s.capacity`,
    )
    .bind(id, name, nowIso(), shiftId)
    .run();
  if (!res.meta.changes) throw new HttpError(409, "This shift is already full");
  await addVersion(db, planId, `${name} → ${describeShift(shift)}`);
  return json({ id, shiftId, name }, 201);
}

async function removeSignup(db, planId, signupId) {
  const row = await db
    .prepare(
      `SELECT u.name, s.role, s.date, s.start_time, s.end_time FROM signups u JOIN shifts s ON s.id = u.shift_id
       WHERE u.id = ? AND s.plan_id = ?`,
    )
    .bind(signupId, planId)
    .first();
  if (!row) throw new HttpError(404, "Sign-up not found");
  await db.prepare("DELETE FROM signups WHERE id = ?").bind(signupId).run();
  await addVersion(db, planId, `${row.name} ✗ ${describeShift(row)}`);
  return json({ success: true });
}

async function listVersions(db, planId) {
  await loadPlan(db, planId);
  const { results } = await db
    .prepare("SELECT version_number, description, created_at FROM versions WHERE plan_id = ? ORDER BY version_number DESC")
    .bind(planId)
    .all();
  return json({ versions: results });
}

async function restoreVersion(db, planId, versionNumber, { adminPassword }) {
  const plan = await loadPlan(db, planId);
  await requireAdmin(plan, adminPassword);
  const version = await db
    .prepare("SELECT snapshot FROM versions WHERE plan_id = ? AND version_number = ?")
    .bind(planId, Number(versionNumber))
    .first();
  if (!version) throw new HttpError(404, "Version not found");
  const snap = JSON.parse(version.snapshot);
  await db.batch([
    db.prepare("DELETE FROM signups WHERE shift_id IN (SELECT id FROM shifts WHERE plan_id = ?)").bind(planId),
    db.prepare("DELETE FROM shifts WHERE plan_id = ?").bind(planId),
    ...snap.shifts.map((s) =>
      insertShift(db, planId, s.id, s.role, s.date, s.start_time, s.end_time ?? null, s.capacity, s.sort_order),
    ),
    ...snap.signups.map((u) =>
      db.prepare("INSERT INTO signups (id, shift_id, name, created_at) VALUES (?, ?, ?, ?)").bind(u.id, u.shift_id, u.name, u.created_at),
    ),
  ]);
  await addVersion(db, planId, `Restored version #${Number(versionNumber)}`);
  return json({ success: true });
}

// ---------- helpers ----------

async function loadPlan(db, planId) {
  const plan = await db.prepare("SELECT * FROM plans WHERE id = ?").bind(planId).first();
  if (!plan) throw new HttpError(404, "Plan not found");
  return plan;
}

async function loadState(db, planId) {
  const [shifts, signups] = await db.batch([
    db.prepare("SELECT * FROM shifts WHERE plan_id = ? ORDER BY sort_order, date, start_time").bind(planId),
    db
      .prepare(
        `SELECT u.* FROM signups u JOIN shifts s ON s.id = u.shift_id
         WHERE s.plan_id = ? ORDER BY u.created_at`,
      )
      .bind(planId),
  ]);
  return { shifts: shifts.results, signups: signups.results };
}

async function addVersion(db, planId, description) {
  const snapshot = JSON.stringify(await loadState(db, planId));
  const now = nowIso();
  await db.batch([
    db
      .prepare(
        `INSERT INTO versions (id, plan_id, version_number, snapshot, description, created_at)
         SELECT ?, ?, COALESCE(MAX(version_number), 0) + 1, ?, ?, ? FROM versions WHERE plan_id = ?`,
      )
      .bind(crypto.randomUUID(), planId, snapshot, description, now, planId),
    db
      .prepare(
        `DELETE FROM versions WHERE plan_id = ?
         AND version_number <= (SELECT MAX(version_number) FROM versions WHERE plan_id = ?) - ?`,
      )
      .bind(planId, planId, MAX_VERSIONS),
    db.prepare("UPDATE plans SET updated_at = ? WHERE id = ?").bind(now, planId),
  ]);
}

function insertShift(db, planId, id, role, date, startTime, endTime, capacity, sortOrder) {
  return db
    .prepare(
      "INSERT INTO shifts (id, plan_id, role, date, start_time, end_time, capacity, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(id, planId, role, date, startTime, endTime, capacity, sortOrder);
}

function describeShift(s) {
  return `${s.role}, ${s.date} ${s.start_time}${s.end_time ? `-${s.end_time}` : ""}`;
}

async function requireAdmin(plan, password) {
  if (!plan.admin_password_hash) return;
  if (!password || !(await checkPassword(String(password), plan.admin_password_hash))) {
    throw new HttpError(403, "Wrong admin password");
  }
}

async function hashPassword(password, salt = crypto.getRandomValues(new Uint8Array(16))) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64(salt)}$${b64(new Uint8Array(bits))}`;
}

async function checkPassword(password, stored) {
  const [, , saltB64] = stored.split("$");
  const salt = Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0));
  const candidate = new TextEncoder().encode(await hashPassword(password, salt));
  const expected = new TextEncoder().encode(stored);
  return candidate.byteLength === expected.byteLength && crypto.subtle.timingSafeEqual(candidate, expected);
}

function b64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}

function requireText(value, label, maxLength) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new HttpError(400, `${label} is required`);
  if (text.length > maxLength) throw new HttpError(400, `${label} is too long (max ${maxLength})`);
  return text;
}

async function body(request) {
  const text = await request.text();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

function nowIso() {
  return new Date().toISOString();
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-app-version": appVersion },
  });
}
