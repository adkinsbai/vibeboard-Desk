import { isNeonConnectionString, resolveDatabaseDriver, resolveSslOption, wrapSqlClient } from "../src/databaseClient.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(isNeonConnectionString("postgresql://user:pass@ep-calm-fire-123456.us-east-1.aws.neon.tech/db"), "neon hostname should be detected");
assert(!isNeonConnectionString("postgresql://user:pass@127.0.0.1:5432/vibeboard"), "local postgres should not be detected as neon");

assert(
  resolveDatabaseDriver("postgresql://user:pass@ep-calm-fire-123456.us-east-1.aws.neon.tech/db", {}) === "neon",
  "neon URL should default to neon driver"
);
assert(
  resolveDatabaseDriver("postgresql://user:pass@127.0.0.1:5432/vibeboard", {}) === "postgres",
  "local URL should default to postgres driver"
);
assert(
  resolveDatabaseDriver("postgresql://user:pass@127.0.0.1:5432/vibeboard", { VIBEBOARD_DATABASE_DRIVER: "neon" }) === "neon",
  "explicit neon override should win"
);
assert(
  resolveDatabaseDriver("postgresql://user:pass@ep-calm-fire-123456.us-east-1.aws.neon.tech/db", { VIBEBOARD_DATABASE_DRIVER: "postgres" }) === "postgres",
  "explicit postgres override should win"
);
assert(
  resolveSslOption("postgresql://user:pass@127.0.0.1:5432/vibeboard", {}) === false,
  "local postgres should not force TLS"
);
assert(
  resolveSslOption("postgresql://user:pass@rds.aliyuncs.com:5432/vibeboard?sslmode=require", {}) === "require",
  "sslmode=require should request TLS"
);

let beginCallbackReturnedArray = false;
const fakeSql = {
  begin(callback) {
    const tx = () => Promise.resolve();
    const result = callback(tx);
    beginCallbackReturnedArray = Array.isArray(result);
    return Promise.resolve(result);
  },
};
const wrapped = wrapSqlClient(fakeSql);
await wrapped.transaction(tx => [tx("delete"), tx("insert")]);
assert(beginCallbackReturnedArray, "transaction adapter must preserve query arrays for postgres.js to await before commit");

console.log("database client driver resolution ok");
