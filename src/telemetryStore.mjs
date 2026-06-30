import crypto from "node:crypto";

const SECRET_KEY_RE = /(password|passwd|pwd|api[_-]?key|apikey|authorization|auth|cookie|session|token|secret|access[_-]?key|database[_-]?url|connection|string|credential|private)/i;
const SECRET_VALUE_RE = /(sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]+|postgres(?:ql)?:\/\/[^\s"'`]+|mysql:\/\/[^\s"'`]+|redis:\/\/[^\s"'`]+|mongodb(?:\+srv)?:\/\/[^\s"'`]+|LTAI[A-Za-z0-9]{12,}|AKIA[A-Z0-9]{12,})/gi;
const MAX_STRING_LENGTH = 1600;
const MAX_ARRAY_LENGTH = 30;
const MAX_OBJECT_KEYS = 60;
const MAX_DEPTH = 5;

export function createTelemetryStore({ sqliteDb = null, saveSqlite = () => {}, pg = null, env = process.env } = {}) {
  const adapter = pg ? createPostgresAdapter(pg) : createSqliteAdapter(sqliteDb, saveSqlite);
  const salt = String(env.VIBEBOARD_TELEMETRY_SALT || env.VIBEBOARD_DB_SNAPSHOT_KEY || "vibeboard-telemetry-salt");

  async function initSchema() {
    await adapter.initSchema();
  }

  async function record({ req = null, user = null, eventType = "client.event", category = "", action = "", page = "", boardId = "", conversationId = "", severity = "info", payload = {}, sessionId = "", userAgent = "" } = {}) {
    const safePayload = sanitizeTelemetry(payload);
    const ip = req ? clientIp(req) : "";
    const resolvedSessionId = sessionId || payload?.session_id || payload?.sessionId || "";
    const row = {
      id: crypto.randomUUID(),
      user_hash: user ? stableHash(`${user.id || ""}:${user.phone || ""}`, salt) : "",
      session_hash: resolvedSessionId ? stableHash(resolvedSessionId, salt) : "",
      event_type: cleanLabel(eventType || payload?.event_type || payload?.type || "client.event", 80),
      category: cleanLabel(category || payload?.category || "", 80),
      action: cleanLabel(action || payload?.action || "", 120),
      page: cleanLabel(page || payload?.page || payload?.path || "", 180),
      board_id: cleanLabel(boardId || payload?.board_id || payload?.boardId || "", 80),
      conversation_hash: conversationId || payload?.conversation_id || payload?.conversationId
        ? stableHash(conversationId || payload?.conversation_id || payload?.conversationId, salt)
        : "",
      severity: cleanLabel(severity || payload?.severity || "info", 24),
      payload_json: JSON.stringify(safePayload),
      user_agent: cleanLabel(userAgent || req?.headers?.["user-agent"] || "", 500),
      ip_hash: ip ? stableHash(ip, salt) : "",
      created_at: new Date().toISOString(),
    };
    await adapter.insert(row);
    return {
      id: row.id,
      user_hash: row.user_hash,
      session_hash: row.session_hash,
      event_type: row.event_type,
      created_at: row.created_at,
    };
  }

  async function recordClientEvent({ req, user, body = {} } = {}) {
    const detail = body.payload && typeof body.payload === "object" ? body.payload : {};
    return record({
      req,
      user,
      eventType: body.event_type || body.type || "client.event",
      category: body.category || detail.category || "client",
      action: body.action || detail.action || "",
      page: body.page || body.path || detail.page || detail.path || "",
      boardId: body.board_id || body.boardId || detail.board_id || detail.boardId || "",
      conversationId: body.conversation_id || body.conversationId || detail.conversation_id || detail.conversationId || "",
      severity: body.severity || detail.severity || "info",
      payload: body.payload || body,
      sessionId: body.session_id || body.sessionId || "",
    });
  }

  async function list({ limit = 200 } = {}) {
    const rows = await adapter.list(limit);
    return rows.map(row => ({
      ...row,
      payload: parsePayload(row.payload_json),
      payload_json: undefined,
    }));
  }

  return {
    initSchema,
    record,
    recordClientEvent,
    list,
    sanitize: sanitizeTelemetry,
  };
}

export function sanitizeTelemetry(value, depth = 0, key = "") {
  if (SECRET_KEY_RE.test(String(key || ""))) return "[redacted]";
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return sanitizeString(value);
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_LENGTH).map((item, index) => sanitizeTelemetry(item, depth + 1, String(index)));
    if (value.length > MAX_ARRAY_LENGTH) items.push(`[truncated ${value.length - MAX_ARRAY_LENGTH} items]`);
    return items;
  }
  if (typeof value === "object") {
    if (depth >= MAX_DEPTH) {
      const keys = Object.keys(value);
      return { type: "object", keys: keys.slice(0, MAX_ARRAY_LENGTH), truncated: Math.max(0, keys.length - MAX_ARRAY_LENGTH) };
    }
    const entries = Object.entries(value).slice(0, MAX_OBJECT_KEYS);
    const result = Object.fromEntries(entries.map(([childKey, childValue]) => [childKey, sanitizeTelemetry(childValue, depth + 1, childKey)]));
    const total = Object.keys(value).length;
    if (total > MAX_OBJECT_KEYS) result.__truncated_keys = total - MAX_OBJECT_KEYS;
    return result;
  }
  return sanitizeString(String(value));
}

function sanitizeString(value) {
  const redacted = String(value || "").replace(SECRET_VALUE_RE, "[redacted]");
  return redacted.length > MAX_STRING_LENGTH
    ? `${redacted.slice(0, MAX_STRING_LENGTH)}... [truncated ${redacted.length - MAX_STRING_LENGTH} chars]`
    : redacted;
}

function parsePayload(value) {
  try {
    return value ? JSON.parse(value) : {};
  } catch {
    return {};
  }
}

function cleanLabel(value, limit) {
  return sanitizeString(String(value || "").replace(/\s+/g, " ").trim()).slice(0, limit);
}

function stableHash(value, salt) {
  return crypto.createHmac("sha256", salt).update(String(value || "")).digest("hex").slice(0, 32);
}

function clientIp(req) {
  const forwarded = String(req?.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || String(req?.socket?.remoteAddress || "");
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
        CREATE TABLE IF NOT EXISTS telemetry_events (
          id TEXT PRIMARY KEY,
          user_hash TEXT,
          session_hash TEXT,
          event_type TEXT NOT NULL,
          category TEXT,
          action TEXT,
          page TEXT,
          board_id TEXT,
          conversation_hash TEXT,
          severity TEXT DEFAULT 'info',
          payload_json TEXT,
          user_agent TEXT,
          ip_hash TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `);
      db.run("CREATE INDEX IF NOT EXISTS idx_telemetry_created_at ON telemetry_events(created_at)");
      db.run("CREATE INDEX IF NOT EXISTS idx_telemetry_user_hash ON telemetry_events(user_hash)");
      saveDb();
    },
    async insert(row) {
      run(
        `INSERT INTO telemetry_events (id, user_hash, session_hash, event_type, category, action, page, board_id, conversation_hash, severity, payload_json, user_agent, ip_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [row.id, row.user_hash, row.session_hash, row.event_type, row.category, row.action, row.page, row.board_id, row.conversation_hash, row.severity, row.payload_json, row.user_agent, row.ip_hash, row.created_at]
      );
    },
    async list(limit) {
      return query("SELECT * FROM telemetry_events ORDER BY created_at DESC LIMIT ?", [Math.max(1, Math.min(1000, Number(limit || 200)))]);
    },
  };
}

function createPostgresAdapter(sql) {
  return {
    async initSchema() {
      await sql`
        CREATE TABLE IF NOT EXISTS telemetry_events (
          id TEXT PRIMARY KEY,
          user_hash TEXT,
          session_hash TEXT,
          event_type TEXT NOT NULL,
          category TEXT,
          action TEXT,
          page TEXT,
          board_id TEXT,
          conversation_hash TEXT,
          severity TEXT DEFAULT 'info',
          payload_json TEXT,
          user_agent TEXT,
          ip_hash TEXT,
          created_at TIMESTAMPTZ DEFAULT now()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS idx_telemetry_created_at ON telemetry_events(created_at)`;
      await sql`CREATE INDEX IF NOT EXISTS idx_telemetry_user_hash ON telemetry_events(user_hash)`;
    },
    async insert(row) {
      await sql`
        INSERT INTO telemetry_events (id, user_hash, session_hash, event_type, category, action, page, board_id, conversation_hash, severity, payload_json, user_agent, ip_hash, created_at)
        VALUES (${row.id}, ${row.user_hash}, ${row.session_hash}, ${row.event_type}, ${row.category}, ${row.action}, ${row.page}, ${row.board_id}, ${row.conversation_hash}, ${row.severity}, ${row.payload_json}, ${row.user_agent}, ${row.ip_hash}, ${row.created_at})
      `;
    },
    async list(limit) {
      return await sql`SELECT * FROM telemetry_events ORDER BY created_at DESC LIMIT ${Math.max(1, Math.min(1000, Number(limit || 200)))}`;
    },
  };
}
