import crypto from "node:crypto";

import initSqlJs from "sql.js";

import { assert } from "./support/serverHarness.mjs";
import { createAssetRelevanceIndex } from "../src/assetRelevanceIndex.mjs";

const SQL = await initSqlJs();

await test("searchRelevantAssets degrades to empty results when the index cannot be used", async () => {
  const db = new SQL.Database();
  const index = createAssetRelevanceIndex(db, () => {});
  const result = await index.searchRelevantAssets("conv-a", "neon button", { limit: 5 });
  assert(Array.isArray(result), "search should always return an array");
  assert(result.length === 0, "missing tables should return an empty result");
});

await test("index ranks exact names and summary facets within the current conversation", async () => {
  const db = createTestDb();
  const index = createAssetRelevanceIndex(db, () => {});
  index.initSchema();
  seedAsset(db, {
    id: "asset-name",
    conversation_id: "conv-a",
    name: "Neon Button Pack",
    kind: "image",
    category: "image",
    usage: "embeddable",
    summary_json: {
      use: "button chrome and neon controls",
      signals: ["Neon glow accent"],
      ctas: ["Tap to start"],
      colors: ["#00ffff", "#ff00aa"]
    },
    updated_at: "2026-08-25 09:10:00"
  });
  seedAsset(db, {
    id: "asset-summary",
    conversation_id: "conv-a",
    name: "Control Sheet",
    kind: "document",
    category: "document",
    usage: "embeddable",
    summary_json: {
      use: "dashboard button copy",
      signals: ["button", "controls"],
      ctas: ["Tap to start"],
      dataFields: ["status", "mode"]
    },
    updated_at: "2026-08-25 09:20:00"
  });
  seedAsset(db, {
    id: "asset-other-conv",
    conversation_id: "conv-b",
    name: "Neon Button Pack",
    kind: "image",
    category: "image",
    usage: "embeddable",
    summary_json: { use: "different conversation" },
    updated_at: "2026-08-25 09:30:00"
  });
  index.rebuild("conv-a");

  const result = await index.searchRelevantAssets("conv-a", "neon button tap", { limit: 5 });
  assert(result.length === 2, "search should stay inside the conversation scope");
  assert(result[0].asset_id === "asset-name", "exact name match should rank first");
  assert(result[0].matched_facets.includes("name"), "name facet should be reported");
  assert(result[0].matched_facets.includes("summary"), "summary facet should be reported");
  assert(result.some(item => item.asset_id === "asset-summary"), "summary-driven asset should be returned");
  assert(result.every(item => item.asset_id !== "asset-other-conv"), "other conversations should be excluded");
});

await test("explicit selections preserve non-embeddable assets and build recency breaks ties", async () => {
  const db = createTestDb();
  const index = createAssetRelevanceIndex(db, () => {});
  index.initSchema();
  seedAsset(db, {
    id: "asset-selected",
    conversation_id: "conv-a",
    name: "Legacy Wireframe",
    kind: "document",
    category: "document",
    usage: "reference_only",
    summary_json: { use: "legacy design reference", signals: ["wireframe"] },
    updated_at: "2026-08-25 08:00:00"
  });
  seedAsset(db, {
    id: "asset-used",
    conversation_id: "conv-a",
    name: "Legacy Wireframe Copy",
    kind: "document",
    category: "document",
    usage: "reference_only",
    summary_json: { use: "legacy design reference", signals: ["wireframe"] },
    updated_at: "2026-08-25 08:30:00"
  });
  seedBuildSnapshot(db, {
    conversation_id: "conv-a",
    build_id: "build-1",
    asset_id: "asset-used",
    created_at: "2026-08-25 09:45:00"
  });
  index.rebuild("conv-a");

  const result = await index.searchRelevantAssets("conv-a", "legacy wireframe", {
    limit: 1,
    selectedAssetIds: ["asset-selected"]
  });

  assert(result.some(item => item.asset_id === "asset-selected"), "explicitly selected assets should always be preserved");
  assert(result[0].asset_id === "asset-selected", "selected asset should appear before inferred results");
  assert(result.some(item => item.asset_id === "asset-used"), "build-used asset should still be eligible");
  assert(result.find(item => item.asset_id === "asset-used").source.build_last_used_at === "2026-08-25 09:45:00", "build recency should be exposed");
});

await test("legacy rows are backfilled lazily and rebuild restores derived rows", async () => {
  const db = createTestDb();
  const index = createAssetRelevanceIndex(db, () => {});
  index.initSchema();
  seedAsset(db, {
    id: "asset-legacy",
    conversation_id: "conv-a",
    name: "Product Brief",
    kind: "document",
    category: "document",
    usage: "embeddable",
    summary_json: { use: "product brief for launch", ctas: ["Launch now"], dataFields: ["timeline", "owner"] },
    updated_at: "2026-08-25 07:00:00"
  });

  const lazy = await index.searchRelevantAssets("conv-a", "launch brief", { limit: 5 });
  assert(lazy.length === 1 && lazy[0].asset_id === "asset-legacy", "search should lazily backfill legacy assets");
  assert(getRows(db, "SELECT asset_id FROM asset_relevance_docs WHERE asset_id = ?", ["asset-legacy"]).length === 1, "lazy backfill should persist a relevance doc");

  db.run("DELETE FROM asset_relevance_docs");
  db.run("DELETE FROM asset_relevance_terms");
  index.rebuild("conv-a");
  assert(getRows(db, "SELECT asset_id FROM asset_relevance_docs WHERE conversation_id = ?", ["conv-a"]).length === 1, "rebuild should repopulate derived rows");
});

function createTestDb() {
  const db = new SQL.Database();
  db.run("CREATE TABLE asset_library (id TEXT PRIMARY KEY, conversation_id TEXT, name TEXT NOT NULL, kind TEXT NOT NULL, category TEXT, usage TEXT, folder_id TEXT, project_path TEXT, summary_json TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)");
  db.run("CREATE TABLE build_asset_snapshots (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, build_id TEXT NOT NULL, asset_id TEXT NOT NULL, usage TEXT NOT NULL, project_path TEXT, generated_path TEXT, sha256 TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)");
  return db;
}

function seedAsset(db, row) {
  db.run("INSERT INTO asset_library (id, conversation_id, name, kind, category, usage, folder_id, project_path, summary_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
    row.id,
    row.conversation_id,
    row.name,
    row.kind,
    row.category || "",
    row.usage || "auto",
    row.folder_id || "",
    row.project_path || "",
    JSON.stringify(row.summary_json || {}),
    row.created_at || row.updated_at || "2026-08-25 00:00:00",
    row.updated_at || row.created_at || "2026-08-25 00:00:00"
  ]);
}

function seedBuildSnapshot(db, row) {
  db.run("INSERT INTO build_asset_snapshots (id, conversation_id, build_id, asset_id, usage, project_path, generated_path, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [
    "snap-" + crypto.randomUUID(),
    row.conversation_id,
    row.build_id,
    row.asset_id,
    row.usage || "used_in_build",
    row.project_path || "",
    row.generated_path || "",
    row.sha256 || "",
    row.created_at || "2026-08-25 00:00:00"
  ]);
}

function getRows(db, sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

async function test(name, fn) {
  try {
    await fn();
    console.log("ok - " + name);
  } catch (error) {
    console.error("not ok - " + name);
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
}
