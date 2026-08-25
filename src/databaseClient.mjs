import { neon } from "@neondatabase/serverless";
import postgres from "postgres";

const DEFAULT_POSTGRES_MAX = 10;

export function createDatabaseClient(connectionString, env = process.env) {
  if (!connectionString) return null;
  const driver = resolveDatabaseDriver(connectionString, env);
  if (driver === "neon") return createNeonClient(connectionString);
  return createPostgresClient(connectionString, env);
}

export function resolveDatabaseDriver(connectionString = "", env = process.env) {
  const explicit = String(env.VIBEBOARD_DATABASE_DRIVER || env.DATABASE_DRIVER || "").trim().toLowerCase();
  if (explicit === "neon" || explicit === "serverless") return "neon";
  if (explicit === "postgres" || explicit === "postgresjs" || explicit === "standard" || explicit === "pg") return "postgres";
  if (isNeonConnectionString(connectionString)) return "neon";
  return "postgres";
}

export function isNeonConnectionString(connectionString = "") {
  try {
    const url = new URL(String(connectionString));
    return /neon\.tech$/i.test(url.hostname) || /neon/i.test(url.hostname);
  } catch {
    return false;
  }
}

export function createPostgresClient(connectionString, env = process.env) {
  const sql = postgres(connectionString, {
    max: readIntegerEnv(env.VIBEBOARD_PG_MAX_CONNECTIONS || env.POSTGRES_MAX_CONNECTIONS, DEFAULT_POSTGRES_MAX),
    idle_timeout: readIntegerEnv(env.VIBEBOARD_PG_IDLE_TIMEOUT_SECONDS || env.POSTGRES_IDLE_TIMEOUT_SECONDS, 30),
    connect_timeout: readIntegerEnv(env.VIBEBOARD_PG_CONNECT_TIMEOUT_SECONDS || env.POSTGRES_CONNECT_TIMEOUT_SECONDS, 10),
    prepare: false,
    ssl: resolveSslOption(connectionString, env),
  });
  return wrapSqlClient(sql);
}

export function createNeonClient(connectionString) {
  return wrapSqlClient(neon(connectionString));
}

export function resolveSslOption(connectionString = "", env = process.env) {
  const explicit = String(env.VIBEBOARD_DATABASE_SSL || env.DATABASE_SSL || "").trim().toLowerCase();
  if (explicit === "0" || explicit === "false" || explicit === "off" || explicit === "disable" || explicit === "disabled") {
    return false;
  }
  if (explicit === "1" || explicit === "true" || explicit === "on" || explicit === "require" || explicit === "required") {
    return "require";
  }
  try {
    const url = new URL(String(connectionString));
    const sslmode = String(url.searchParams.get("sslmode") || "").toLowerCase();
    if (sslmode === "disable") return false;
    if (sslmode === "require" || sslmode === "prefer" || sslmode === "verify-ca" || sslmode === "verify-full") {
      return "require";
    }
  } catch {
    // Ignore malformed URLs and fall through to non-TLS.
  }
  return false;
}

export function wrapSqlClient(sql) {
  const client = (...args) => sql(...args);
  // Keep the callback synchronous so postgres.js can detect and await query arrays before COMMIT.
  client.transaction = fn => sql.begin(tx => fn(tx));
  client.end = (...args) => (typeof sql.end === "function" ? sql.end(...args) : Promise.resolve());
  return client;
}

function readIntegerEnv(value, fallback) {
  const number = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
