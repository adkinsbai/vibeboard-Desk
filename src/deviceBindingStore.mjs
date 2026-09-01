import { createBoardConfig } from "./devices.mjs";
import { httpError } from "./authStore.mjs";

const SERIAL_RE = /^[A-Z]{8}\d{4}$/;

export function normalizeDeviceSerial(value = "") {
  return String(value || "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

export function isValidDeviceSerial(value = "") {
  return SERIAL_RE.test(normalizeDeviceSerial(value));
}

export function createDeviceBindingStore({ sqliteDb = null, saveSqlite = () => {}, pg = null, env = process.env } = {}) {
  const adapter = pg ? createPostgresAdapter(pg) : createSqliteAdapter(sqliteDb, saveSqlite);

  async function initSchema() {
    await adapter.initSchema();
    await seedInventory();
  }

  async function seedInventory() {
    for (const device of inventoryFromEnv(env)) {
      await adapter.insertDeviceIfMissing(normalizeInventoryDevice(device));
    }
  }

  async function listForUser(userId) {
    if (!userId) return [];
    return (await adapter.listForUser(userId)).map(publicDevice);
  }

  async function bindSerial({ userId, serial } = {}) {
    if (!userId) throw httpError(401, "Login required.");
    const normalized = normalizeDeviceSerial(serial);
    if (!isValidDeviceSerial(normalized)) {
      throw httpError(400, "Device serial must be 8 letters followed by 4 digits.");
    }

    const device = await adapter.deviceBySerial(normalized);
    if (!device) throw httpError(404, "Device serial was not found.");
    if (device.bound_user_id && device.bound_user_id !== userId) {
      throw httpError(409, "This device is already bound to another account.");
    }
    if (!device.bound_user_id) {
      await adapter.bindDevice(normalized, userId, new Date().toISOString());
    }
    const updated = await adapter.deviceBySerial(normalized);
    if (updated?.bound_user_id && updated.bound_user_id !== userId) {
      throw httpError(409, "This device is already bound to another account.");
    }
    return {
      device: publicDevice(updated),
      devices: await listForUser(userId),
    };
  }

  async function resolveForUser({ userId, serial } = {}) {
    const normalized = normalizeDeviceSerial(serial);
    if (!normalized) return null;
    if (!isValidDeviceSerial(normalized)) throw httpError(400, "Device serial must be 8 letters followed by 4 digits.");
    const device = await adapter.deviceBySerial(normalized);
    if (!device) throw httpError(404, "Device serial was not found.");
    if (!userId || device.bound_user_id !== userId) {
      throw httpError(403, "Device access denied.");
    }
    return privateDevice(device);
  }

  return {
    initSchema,
    listForUser,
    bindSerial,
    resolveForUser,
  };
}

function inventoryFromEnv(env) {
  const builtIn = defaultInventory(env);
  const raw = String(env.VIBEBOARD_DEVICE_INVENTORY || "").trim();
  if (!raw) return builtIn;
  let custom = [];
  try {
    custom = JSON.parse(raw);
  } catch {
    custom = [];
  }
  if (!Array.isArray(custom)) custom = [];
  const merged = new Map();
  const source = env.VIBEBOARD_DEVICE_INVENTORY_REPLACE === "1" ? custom : [...builtIn, ...custom];
  for (const item of source) {
    const serial = normalizeDeviceSerial(item?.serial);
    if (serial) merged.set(serial, { ...item, serial });
  }
  return [...merged.values()];
}

function defaultInventory(env) {
  const gray = createBoardConfig("taishan-gray", env);
  const grayConnection = {
    mode: "frp",
    host: gray.frpHost || gray.host || "",
    port: String(gray.frpPort || gray.port || ""),
    user: gray.user || "linaro",
  };
  return [
    {
      serial: "GRAYUNIT2026",
      label: "灰色版小电脑",
      model: "泰山派 RK3566",
      color: "gray",
      board_id: "taishan-gray",
      status: "ready",
      connection: grayConnection,
    },
    {
      serial: "WHITEBOX2026",
      label: "白色版小电脑",
      model: "泰山派 RK3566",
      color: "white",
      board_id: "taishan-gray",
      status: "ready",
      connection: { mode: "preview" },
    },
  ];
}

function normalizeInventoryDevice(device = {}) {
  const serial = normalizeDeviceSerial(device.serial);
  const boardId = String(device.board_id || device.boardId || "taishan-gray").trim() || "taishan-gray";
  const connection = device.connection && typeof device.connection === "object"
    ? device.connection
    : parseConnectionJson(device.connection_json || device.connectionJson);
  return {
    serial,
    label: String(device.label || "VibeBoard 设备").trim(),
    model: String(device.model || "泰山派 RK3566").trim(),
    color: String(device.color || "").trim(),
    board_id: boardId,
    status: String(device.status || "ready").trim(),
    connection_json: JSON.stringify(connection || { mode: "preview" }),
    route: String(device.route || `/workbench?board=${encodeURIComponent(boardId)}&device=${encodeURIComponent(serial)}`).trim(),
  };
}

function publicDevice(row = {}) {
  const connection = parseConnectionJson(row.connection_json);
  return {
    serial: row.serial,
    serial_mask: maskSerial(row.serial),
    label: row.label,
    model: row.model,
    color: row.color,
    board_id: row.board_id || "taishan-gray",
    status: row.status || "ready",
    connection_mode: connection.mode || "preview",
    route: row.route || `/workbench?board=${encodeURIComponent(row.board_id || "taishan-gray")}&device=${encodeURIComponent(row.serial || "")}`,
    bound_at: row.bound_at || "",
  };
}

function privateDevice(row = {}) {
  return {
    ...publicDevice(row),
    connection: parseConnectionJson(row.connection_json),
  };
}

function maskSerial(serial = "") {
  const normalized = normalizeDeviceSerial(serial);
  if (normalized.length < 8) return normalized;
  return `${normalized.slice(0, 4)}****${normalized.slice(-4)}`;
}

function parseConnectionJson(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
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
        CREATE TABLE IF NOT EXISTS hardware_devices (
          serial TEXT PRIMARY KEY,
          label TEXT NOT NULL,
          model TEXT,
          color TEXT,
          board_id TEXT DEFAULT 'taishan-gray',
          status TEXT DEFAULT 'ready',
          connection_json TEXT,
          route TEXT,
          bound_user_id TEXT,
          bound_at TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `);
      db.run("CREATE INDEX IF NOT EXISTS idx_hardware_devices_bound_user ON hardware_devices(bound_user_id)");
      saveDb();
    },
    async insertDeviceIfMissing(device) {
      run(
        `INSERT OR IGNORE INTO hardware_devices
          (serial, label, model, color, board_id, status, connection_json, route, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [device.serial, device.label, device.model, device.color, device.board_id, device.status, device.connection_json, device.route]
      );
    },
    async deviceBySerial(serial) {
      return query("SELECT * FROM hardware_devices WHERE serial = ? LIMIT 1", [serial])[0] || null;
    },
    async bindDevice(serial, userId, boundAt) {
      run(
        "UPDATE hardware_devices SET bound_user_id = ?, bound_at = ?, updated_at = CURRENT_TIMESTAMP WHERE serial = ? AND bound_user_id IS NULL",
        [userId, boundAt, serial]
      );
    },
    async listForUser(userId) {
      return query("SELECT * FROM hardware_devices WHERE bound_user_id = ? ORDER BY bound_at DESC, label ASC", [userId]);
    },
  };
}

function createPostgresAdapter(sql) {
  return {
    async initSchema() {
      await sql`
        CREATE TABLE IF NOT EXISTS hardware_devices (
          serial TEXT PRIMARY KEY,
          label TEXT NOT NULL,
          model TEXT,
          color TEXT,
          board_id TEXT DEFAULT 'taishan-gray',
          status TEXT DEFAULT 'ready',
          connection_json TEXT,
          route TEXT,
          bound_user_id TEXT,
          bound_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ DEFAULT now(),
          updated_at TIMESTAMPTZ DEFAULT now()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS idx_hardware_devices_bound_user ON hardware_devices(bound_user_id)`;
    },
    async insertDeviceIfMissing(device) {
      await sql`
        INSERT INTO hardware_devices (serial, label, model, color, board_id, status, connection_json, route, created_at, updated_at)
        VALUES (${device.serial}, ${device.label}, ${device.model}, ${device.color}, ${device.board_id}, ${device.status}, ${device.connection_json}, ${device.route}, now(), now())
        ON CONFLICT (serial) DO NOTHING
      `;
    },
    async deviceBySerial(serial) {
      return (await sql`SELECT * FROM hardware_devices WHERE serial = ${serial} LIMIT 1`)[0] || null;
    },
    async bindDevice(serial, userId, boundAt) {
      await sql`
        UPDATE hardware_devices
        SET bound_user_id = ${userId}, bound_at = ${boundAt}, updated_at = now()
        WHERE serial = ${serial} AND bound_user_id IS NULL
      `;
    },
    async listForUser(userId) {
      return await sql`SELECT * FROM hardware_devices WHERE bound_user_id = ${userId} ORDER BY bound_at DESC, label ASC`;
    },
  };
}
