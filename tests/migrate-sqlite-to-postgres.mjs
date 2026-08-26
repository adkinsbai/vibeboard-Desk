import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const result = spawnSync(process.execPath, ["scripts/migrate-sqlite-to-postgres.mjs"], {
  cwd: process.cwd(),
  env: { PATH: process.env.PATH },
  encoding: "utf8",
});

assert.notEqual(result.status, 0, "migration must refuse to run without an explicit database URL");
assert.match(
  `${result.stdout}\n${result.stderr}`,
  /DATABASE_URL is required/i,
  "migration should explain the missing database URL"
);

console.log("sqlite-to-postgres migration safety gate ok");
