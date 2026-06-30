import crypto from "node:crypto";

export const FREE_CREDITS = 0;
export const SESSION_COOKIE = "vb_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const PHONE_RE = /^\+?[1-9]\d{7,14}$/;

export function normalizePhone(value = "") {
  const phone = String(value || "").replace(/[\s\-()]/g, "").trim();
  const mainlandChina = phone.match(/^(?:\+?86|0086)?(1\d{10})$/);
  if (mainlandChina) return `+86${mainlandChina[1]}`;
  return phone;
}

export function isValidPhone(value = "") {
  return PHONE_RE.test(normalizePhone(value));
}

export function createAuthStore({ sqliteDb = null, saveSqlite = () => {}, pg = null, env = process.env } = {}) {
  const adapter = pg ? createPostgresAdapter(pg) : createSqliteAdapter(sqliteDb, saveSqlite);
  const adminPhones = new Set(String(env.VIBEBOARD_ADMIN_PHONES || env.VIBEBOARD_ADMIN_PHONE || "")
    .split(",")
    .map(normalizePhone)
    .filter(Boolean));

  async function initSchema() {
    await adapter.initSchema();
  }

  async function createVerification({ phone, purpose = "register", code, ttlSeconds = 600 } = {}) {
    const normalized = normalizePhone(phone);
    if (!isValidPhone(normalized)) throw httpError(400, "Invalid phone number.");
    const latest = await adapter.latestVerification(normalized, purpose);
    if (latest && Date.parse(latest.created_at || "") > Date.now() - 60 * 1000) {
      throw httpError(429, "Please wait before requesting another verification code.");
    }
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
    const token = crypto.randomUUID();
    const hash = hashCode(code);
    await adapter.insertVerification({
      id: crypto.randomUUID(),
      phone: normalized,
      purpose,
      code_hash: hash,
      token,
      expires_at: expiresAt,
    });
    return { phone: normalized, token, expires_at: expiresAt };
  }

  async function verifyPhoneCode({ phone, purpose = "register", code } = {}) {
    const normalized = normalizePhone(phone);
    const latest = await adapter.latestVerification(normalized, purpose);
    if (!latest) throw httpError(400, "Verification code not found.");
    if (latest.consumed_at) throw httpError(400, "Verification code has been used.");
    if (new Date(latest.expires_at).getTime() < Date.now()) throw httpError(400, "Verification code expired.");
    if (latest.code_hash !== hashCode(code)) throw httpError(400, "Verification code is incorrect.");
    await adapter.consumeVerification(latest.id);
    return { phone: normalized, token: latest.token };
  }

  async function createUser({ phone, password, verificationToken, requireVerification = false } = {}) {
    const normalized = normalizePhone(phone);
    if (!isValidPhone(normalized)) throw httpError(400, "Invalid phone number.");
    if (String(password || "").length < 8) throw httpError(400, "Password must be at least 8 characters.");
    const existing = await adapter.userByPhone(normalized);
    if (existing) throw httpError(409, "This phone number is already registered.");

    let verified = null;
    if (requireVerification) {
      verified = await adapter.findConsumedVerification(normalized, "register", verificationToken);
      if (!verified) throw httpError(400, "Phone verification is required.");
    }

    const now = new Date().toISOString();
    const user = {
      id: crypto.randomUUID(),
      phone: normalized,
      password_hash: hashPassword(password),
      role: adminPhones.has(normalized) ? "admin" : "user",
      credits_balance: FREE_CREDITS,
      free_credits_granted: FREE_CREDITS,
      created_at: now,
      updated_at: now,
    };
    await adapter.insertUser(user);
    if (FREE_CREDITS > 0) {
      await adapter.insertCreditLedger({
        id: crypto.randomUUID(),
        user_id: user.id,
        delta: FREE_CREDITS,
        balance_after: FREE_CREDITS,
        reason: "free_signup",
        tokens: 0,
        metadata_json: JSON.stringify({ phone_verified: Boolean(verified) }),
        created_at: now,
      });
    }
    return publicUser(user);
  }

  async function login({ phone, password } = {}) {
    const user = await adapter.userByPhone(normalizePhone(phone));
    if (!user || !verifyPassword(password, user.password_hash)) throw httpError(401, "Invalid phone or password.");
    const session = await createSession(user.id);
    return { user: publicUser(user), session };
  }

  async function createSession(userId) {
    const token = randomToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_MAX_AGE_SECONDS * 1000).toISOString();
    const session = {
      id: crypto.randomUUID(),
      user_id: userId,
      token_hash: hashToken(token),
      expires_at: expiresAt,
      created_at: now.toISOString(),
    };
    await adapter.insertSession(session);
    return { token, expires_at: expiresAt, max_age_seconds: SESSION_MAX_AGE_SECONDS };
  }

  async function currentUserFromRequest(req) {
    const token = readCookie(req, SESSION_COOKIE);
    if (!token) return null;
    const session = await adapter.sessionByTokenHash(hashToken(token));
    if (!session || new Date(session.expires_at).getTime() < Date.now()) return null;
    const user = await adapter.userById(session.user_id);
    return user ? publicUser(user) : null;
  }

  async function logout(req) {
    const token = readCookie(req, SESSION_COOKIE);
    if (token) await adapter.deleteSession(hashToken(token));
  }

  async function requireUser(req) {
    const user = await currentUserFromRequest(req);
    if (!user) throw httpError(401, "Login required.");
    return user;
  }

  async function requireAdmin(req) {
    const user = await requireUser(req);
    if (user.role !== "admin") throw httpError(403, "Admin access required.");
    return user;
  }

  async function listUsers({ limit = 100 } = {}) {
    return adapter.listUsers(limit);
  }

  async function userCreditSummary(userId) {
    return adapter.userCreditSummary(userId);
  }

  async function listCreditLedger({ userId = "", limit = 100 } = {}) {
    return adapter.listCreditLedger({ userId, limit });
  }

  async function applyCreditDelta({ userId, delta, reason, tokens = 0, metadata = {} } = {}) {
    const user = await adapter.userById(userId);
    if (!user) throw httpError(404, "User not found.");
    const next = Number(user.credits_balance || 0) + Number(delta || 0);
    if (next < -1e-9) throw httpError(402, "Insufficient credits.");
    await adapter.updateUserCredits(userId, next);
    await adapter.insertCreditLedger({
      id: crypto.randomUUID(),
      user_id: userId,
      delta: Number(delta || 0),
      balance_after: next,
      reason,
      tokens: Number(tokens || 0),
      metadata_json: JSON.stringify(metadata || {}),
      created_at: new Date().toISOString(),
    });
    return { balance: next };
  }

  return {
    initSchema,
    createVerification,
    verifyPhoneCode,
    createUser,
    login,
    logout,
    currentUserFromRequest,
    requireUser,
    requireAdmin,
    listUsers,
    userCreditSummary,
    listCreditLedger,
    applyCreditDelta,
  };
}

export function sessionCookie(token, { maxAge = SESSION_MAX_AGE_SECONDS, secure = false } = {}) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Number(maxAge || 0))}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function publicUser(user = {}) {
  if (!user) return null;
  return {
    id: user.id,
    phone: user.phone,
    role: user.role || "user",
    credits_balance: Number(user.credits_balance || 0),
    free_credits_granted: Number(user.free_credits_granted || 0),
    created_at: user.created_at,
    updated_at: user.updated_at,
  };
}

export function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function createSqliteAdapter(db, saveDb) {
  if (!db) throw new Error("sqlite db is required");
  function query(sql, params = []) {
    const stmt = db.prepare(sql);
    if (params.length) stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }
  function run(sql, params = []) {
    db.run(sql, params);
    saveDb();
  }
  return {
    async initSchema() {
      db.run(`
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          phone TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          role TEXT DEFAULT 'user',
          credits_balance REAL DEFAULT 0,
          free_credits_granted REAL DEFAULT 0,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `);
      db.run(`
        CREATE TABLE IF NOT EXISTS phone_verifications (
          id TEXT PRIMARY KEY,
          phone TEXT NOT NULL,
          purpose TEXT NOT NULL,
          code_hash TEXT NOT NULL,
          token TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          consumed_at TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `);
      db.run(`
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          token_hash TEXT UNIQUE NOT NULL,
          expires_at TEXT NOT NULL,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `);
      db.run(`
        CREATE TABLE IF NOT EXISTS credit_ledger (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          delta REAL NOT NULL,
          balance_after REAL NOT NULL,
          reason TEXT NOT NULL,
          tokens INTEGER DEFAULT 0,
          metadata_json TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `);
      saveDb();
    },
    async insertVerification(row) {
      run(
        "INSERT INTO phone_verifications (id, phone, purpose, code_hash, token, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
        [row.id, row.phone, row.purpose, row.code_hash, row.token, row.expires_at]
      );
    },
    async latestVerification(phone, purpose) {
      return query(
        "SELECT * FROM phone_verifications WHERE phone = ? AND purpose = ? ORDER BY created_at DESC LIMIT 1",
        [phone, purpose]
      )[0] || null;
    },
    async consumeVerification(id) {
      run("UPDATE phone_verifications SET consumed_at = CURRENT_TIMESTAMP WHERE id = ?", [id]);
    },
    async findConsumedVerification(phone, purpose, token) {
      return query(
        "SELECT * FROM phone_verifications WHERE phone = ? AND purpose = ? AND token = ? AND consumed_at IS NOT NULL ORDER BY consumed_at DESC LIMIT 1",
        [phone, purpose, String(token || "")]
      )[0] || null;
    },
    async userByPhone(phone) {
      return query("SELECT * FROM users WHERE phone = ?", [phone])[0] || null;
    },
    async userById(id) {
      return query("SELECT * FROM users WHERE id = ?", [id])[0] || null;
    },
    async insertUser(user) {
      run(
        `INSERT INTO users (id, phone, password_hash, role, credits_balance, free_credits_granted, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [user.id, user.phone, user.password_hash, user.role, user.credits_balance, user.free_credits_granted, user.created_at, user.updated_at]
      );
    },
    async insertSession(session) {
      run(
        "INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
        [session.id, session.user_id, session.token_hash, session.expires_at, session.created_at]
      );
    },
    async sessionByTokenHash(tokenHash) {
      return query("SELECT * FROM sessions WHERE token_hash = ?", [tokenHash])[0] || null;
    },
    async deleteSession(tokenHash) {
      run("DELETE FROM sessions WHERE token_hash = ?", [tokenHash]);
    },
    async listUsers(limit) {
      return query("SELECT id, phone, role, credits_balance, free_credits_granted, created_at, updated_at FROM users ORDER BY created_at DESC LIMIT ?", [limit]);
    },
    async userCreditSummary(userId) {
      return query("SELECT id, phone, role, credits_balance, free_credits_granted, created_at, updated_at FROM users WHERE id = ?", [userId])[0] || null;
    },
    async listCreditLedger({ userId = "", limit = 100 } = {}) {
      const params = [];
      let where = "";
      if (userId) {
        where = "WHERE user_id = ?";
        params.push(userId);
      }
      params.push(limit);
      return query(`SELECT * FROM credit_ledger ${where} ORDER BY created_at DESC LIMIT ?`, params);
    },
    async updateUserCredits(userId, balance) {
      run("UPDATE users SET credits_balance = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [balance, userId]);
    },
    async insertCreditLedger(row) {
      run(
        `INSERT INTO credit_ledger (id, user_id, delta, balance_after, reason, tokens, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [row.id, row.user_id, row.delta, row.balance_after, row.reason, row.tokens, row.metadata_json, row.created_at]
      );
    },
  };
}

function createPostgresAdapter(sql) {
  return {
    async initSchema() {
      await sql`
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          phone TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          role TEXT DEFAULT 'user',
          credits_balance DOUBLE PRECISION DEFAULT 0,
          free_credits_granted DOUBLE PRECISION DEFAULT 0,
          created_at TIMESTAMPTZ DEFAULT now(),
          updated_at TIMESTAMPTZ DEFAULT now()
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS phone_verifications (
          id TEXT PRIMARY KEY,
          phone TEXT NOT NULL,
          purpose TEXT NOT NULL,
          code_hash TEXT NOT NULL,
          token TEXT NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          consumed_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ DEFAULT now()
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          token_hash TEXT UNIQUE NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ DEFAULT now()
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS credit_ledger (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          delta DOUBLE PRECISION NOT NULL,
          balance_after DOUBLE PRECISION NOT NULL,
          reason TEXT NOT NULL,
          tokens INTEGER DEFAULT 0,
          metadata_json TEXT,
          created_at TIMESTAMPTZ DEFAULT now()
        )
      `;
    },
    async insertVerification(row) {
      await sql`INSERT INTO phone_verifications (id, phone, purpose, code_hash, token, expires_at) VALUES (${row.id}, ${row.phone}, ${row.purpose}, ${row.code_hash}, ${row.token}, ${row.expires_at})`;
    },
    async latestVerification(phone, purpose) {
      return (await sql`SELECT * FROM phone_verifications WHERE phone = ${phone} AND purpose = ${purpose} ORDER BY created_at DESC LIMIT 1`)[0] || null;
    },
    async consumeVerification(id) {
      await sql`UPDATE phone_verifications SET consumed_at = now() WHERE id = ${id}`;
    },
    async findConsumedVerification(phone, purpose, token) {
      return (await sql`SELECT * FROM phone_verifications WHERE phone = ${phone} AND purpose = ${purpose} AND token = ${String(token || "")} AND consumed_at IS NOT NULL ORDER BY consumed_at DESC LIMIT 1`)[0] || null;
    },
    async userByPhone(phone) {
      return (await sql`SELECT * FROM users WHERE phone = ${phone}`)[0] || null;
    },
    async userById(id) {
      return (await sql`SELECT * FROM users WHERE id = ${id}`)[0] || null;
    },
    async insertUser(user) {
      await sql`
        INSERT INTO users (id, phone, password_hash, role, credits_balance, free_credits_granted, created_at, updated_at)
        VALUES (${user.id}, ${user.phone}, ${user.password_hash}, ${user.role}, ${user.credits_balance}, ${user.free_credits_granted}, ${user.created_at}, ${user.updated_at})
      `;
    },
    async insertSession(session) {
      await sql`INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (${session.id}, ${session.user_id}, ${session.token_hash}, ${session.expires_at}, ${session.created_at})`;
    },
    async sessionByTokenHash(tokenHash) {
      return (await sql`SELECT * FROM sessions WHERE token_hash = ${tokenHash}`)[0] || null;
    },
    async deleteSession(tokenHash) {
      await sql`DELETE FROM sessions WHERE token_hash = ${tokenHash}`;
    },
    async listUsers(limit) {
      return await sql`SELECT id, phone, role, credits_balance, free_credits_granted, created_at, updated_at FROM users ORDER BY created_at DESC LIMIT ${limit}`;
    },
    async userCreditSummary(userId) {
      return (await sql`SELECT id, phone, role, credits_balance, free_credits_granted, created_at, updated_at FROM users WHERE id = ${userId}`)[0] || null;
    },
    async listCreditLedger({ userId = "", limit = 100 } = {}) {
      if (userId) return await sql`SELECT * FROM credit_ledger WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT ${limit}`;
      return await sql`SELECT * FROM credit_ledger ORDER BY created_at DESC LIMIT ${limit}`;
    },
    async updateUserCredits(userId, balance) {
      await sql`UPDATE users SET credits_balance = ${balance}, updated_at = now() WHERE id = ${userId}`;
    },
    async insertCreditLedger(row) {
      await sql`
        INSERT INTO credit_ledger (id, user_id, delta, balance_after, reason, tokens, metadata_json, created_at)
        VALUES (${row.id}, ${row.user_id}, ${row.delta}, ${row.balance_after}, ${row.reason}, ${row.tokens}, ${row.metadata_json}, ${row.created_at})
      `;
    },
  };
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password || ""), salt, 64).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [kind, salt, hash] = String(stored || "").split(":");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const candidate = crypto.scryptSync(String(password || ""), salt, 64);
  const storedHash = Buffer.from(hash, "hex");
  if (storedHash.length !== candidate.length) return false;
  return crypto.timingSafeEqual(storedHash, candidate);
}

function hashCode(code) {
  return crypto.createHash("sha256").update(String(code || "")).digest("hex");
}

function randomToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function readCookie(req, name) {
  const raw = String(req.headers.cookie || "");
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("=") || "");
  }
  return "";
}
