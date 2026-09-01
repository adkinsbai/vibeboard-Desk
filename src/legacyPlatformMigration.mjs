const TABLES = [
  "hardware_devices",
  "users",
  "phone_verifications",
  "sessions",
  "credit_ledger",
  "telemetry_events",
];

export function legacyPlatformTableNames() {
  return [...TABLES];
}

export async function migrateLegacyPlatformRows(sql, rowsByTable = {}) {
  const stats = Object.fromEntries(TABLES.map(table => [table, 0]));

  for (const row of rowsByTable.hardware_devices || []) {
    await sql`
      INSERT INTO hardware_devices (serial, label, model, color, board_id, status, connection_json, route, bound_user_id, bound_at, created_at, updated_at)
      VALUES (${text(row.serial)}, ${text(row.label, "VibeBoard device")}, ${text(row.model)}, ${text(row.color)}, ${text(row.board_id, "taishan-gray")}, ${text(row.status, "ready")}, ${text(row.connection_json, "{}")}, ${text(row.route)}, ${nullable(row.bound_user_id)}, ${nullable(row.bound_at)}, ${timestamp(row.created_at)}, ${timestamp(row.updated_at)})
      ON CONFLICT (serial) DO UPDATE SET
        label = EXCLUDED.label,
        model = EXCLUDED.model,
        color = EXCLUDED.color,
        board_id = EXCLUDED.board_id,
        status = EXCLUDED.status,
        connection_json = EXCLUDED.connection_json,
        route = EXCLUDED.route,
        bound_user_id = COALESCE(hardware_devices.bound_user_id, EXCLUDED.bound_user_id),
        bound_at = COALESCE(hardware_devices.bound_at, EXCLUDED.bound_at),
        updated_at = GREATEST(hardware_devices.updated_at, EXCLUDED.updated_at)
    `;
    stats.hardware_devices += 1;
  }

  for (const row of rowsByTable.users || []) {
    await sql`
      INSERT INTO users (id, phone, password_hash, role, credits_balance, free_credits_granted, created_at, updated_at)
      VALUES (${text(row.id)}, ${text(row.phone)}, ${text(row.password_hash)}, ${text(row.role, "user")}, ${number(row.credits_balance)}, ${number(row.free_credits_granted)}, ${timestamp(row.created_at)}, ${timestamp(row.updated_at)})
      ON CONFLICT (id) DO NOTHING
    `;
    stats.users += 1;
  }

  for (const row of rowsByTable.phone_verifications || []) {
    await sql`
      INSERT INTO phone_verifications (id, phone, purpose, code_hash, token, expires_at, consumed_at, created_at)
      VALUES (${text(row.id)}, ${text(row.phone)}, ${text(row.purpose)}, ${text(row.code_hash)}, ${text(row.token)}, ${timestamp(row.expires_at)}, ${nullable(row.consumed_at)}, ${timestamp(row.created_at)})
      ON CONFLICT (id) DO NOTHING
    `;
    stats.phone_verifications += 1;
  }

  for (const row of rowsByTable.sessions || []) {
    await sql`
      INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
      VALUES (${text(row.id)}, ${text(row.user_id)}, ${text(row.token_hash)}, ${timestamp(row.expires_at)}, ${timestamp(row.created_at)})
      ON CONFLICT (id) DO NOTHING
    `;
    stats.sessions += 1;
  }

  for (const row of rowsByTable.credit_ledger || []) {
    await sql`
      INSERT INTO credit_ledger (id, user_id, delta, balance_after, reason, tokens, metadata_json, created_at)
      VALUES (${text(row.id)}, ${text(row.user_id)}, ${number(row.delta)}, ${number(row.balance_after)}, ${text(row.reason)}, ${integer(row.tokens)}, ${nullable(row.metadata_json)}, ${timestamp(row.created_at)})
      ON CONFLICT (id) DO NOTHING
    `;
    stats.credit_ledger += 1;
  }

  for (const row of rowsByTable.telemetry_events || []) {
    await sql`
      INSERT INTO telemetry_events (id, user_hash, session_hash, event_type, category, action, page, board_id, conversation_hash, severity, payload_json, user_agent, ip_hash, created_at)
      VALUES (${text(row.id)}, ${text(row.user_hash)}, ${text(row.session_hash)}, ${text(row.event_type)}, ${text(row.category)}, ${text(row.action)}, ${text(row.page)}, ${text(row.board_id)}, ${text(row.conversation_hash)}, ${text(row.severity, "info")}, ${nullable(row.payload_json)}, ${text(row.user_agent)}, ${text(row.ip_hash)}, ${timestamp(row.created_at)})
      ON CONFLICT (id) DO NOTHING
    `;
    stats.telemetry_events += 1;
  }

  return stats;
}

function text(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function nullable(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function integer(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function timestamp(value) {
  return nullable(value) || new Date().toISOString();
}
