const DEFAULT_KEY = "vibeboard-main";

export function createCloudSqliteSnapshot({ pg, key = DEFAULT_KEY } = {}) {
  if (!pg) return null;
  const snapshotKey = String(key || DEFAULT_KEY);

  async function initSchema() {
    await pg`
      CREATE TABLE IF NOT EXISTS sqlite_snapshots (
        key TEXT PRIMARY KEY,
        data_base64 TEXT NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT now()
      )
    `;
  }

  async function load() {
    const rows = await pg`SELECT data_base64 FROM sqlite_snapshots WHERE key = ${snapshotKey} LIMIT 1`;
    const value = rows?.[0]?.data_base64 || "";
    return value ? Buffer.from(String(value), "base64") : null;
  }

  async function save(buffer) {
    const dataBase64 = Buffer.from(buffer || []).toString("base64");
    await pg`
      INSERT INTO sqlite_snapshots (key, data_base64, updated_at)
      VALUES (${snapshotKey}, ${dataBase64}, now())
      ON CONFLICT (key) DO UPDATE
      SET data_base64 = EXCLUDED.data_base64,
          updated_at = now()
    `;
  }

  return { initSchema, load, save };
}
