import assert from "node:assert/strict";

import { migrateLegacyPlatformRows } from "../src/legacyPlatformMigration.mjs";

const calls = [];
const sql = async (strings, ...values) => {
  calls.push({ text: strings.join("?"), values });
  return [];
};

const result = await migrateLegacyPlatformRows(sql, {
  hardware_devices: [{ serial: "GRAYUNIT2026", label: "Gray", model: "RK3566", color: "gray", board_id: "taishan-gray", status: "ready", connection_json: "{}", route: "/workbench", bound_user_id: "", bound_at: null, created_at: "2026-07-28T00:00:00Z", updated_at: "2026-07-28T00:00:00Z" }],
  users: [{ id: "user-1", phone: "13800000000", password_hash: "hash", role: "user", credits_balance: 2, free_credits_granted: 1, created_at: "2026-07-28T00:00:00Z", updated_at: "2026-07-28T00:00:00Z" }],
  sessions: [{ id: "session-1", user_id: "user-1", token_hash: "token", expires_at: "2026-07-29T00:00:00Z", created_at: "2026-07-28T00:00:00Z" }],
  credit_ledger: [{ id: "credit-1", user_id: "user-1", delta: 2, balance_after: 2, reason: "grant", tokens: 0, metadata_json: "{}", created_at: "2026-07-28T00:00:00Z" }],
  phone_verifications: [],
  telemetry_events: [{ id: "telemetry-1", event_type: "test", created_at: "2026-07-28T00:00:00Z" }],
});

assert.deepEqual(result, { hardware_devices: 1, users: 1, sessions: 1, credit_ledger: 1, phone_verifications: 0, telemetry_events: 1 });
assert.equal(calls.length, 5, "each non-empty legacy table should be imported");
assert.match(calls[0].text, /hardware_devices/i, "device inventory should be migrated");
assert.match(calls[0].text, /ON CONFLICT \(serial\) DO UPDATE/i, "device inventory should preserve the useful local connection data");
assert.match(calls[1].text, /ON CONFLICT \(id\) DO NOTHING/i, "identity rows should be safe to re-run");
assert.match(calls[4].text, /telemetry_events/i, "telemetry history should be migrated");

console.log("legacy platform migration rows ok");
