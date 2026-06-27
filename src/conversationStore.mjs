import crypto from "node:crypto";

import {
  declaredAssetPathsFromFiles,
  deserializeFileMap,
  serializeFileMap,
} from "./assetContract.mjs";
import { CONVERSATION_SNAPSHOT_FILE_NAMES } from "./contracts.mjs";

export const CONVERSATION_FILE_NAMES = new Set(CONVERSATION_SNAPSHOT_FILE_NAMES);

export function filterConversationFiles(files = {}) {
  const decoded = deserializeFileMap(files);
  const declaredAssets = new Set(declaredAssetPathsFromFiles(decoded));
  const filtered = {};
  for (const [filename, content] of Object.entries(decoded || {})) {
    if (!CONVERSATION_FILE_NAMES.has(filename) && !declaredAssets.has(filename)) continue;
    filtered[filename] = content;
  }
  return filtered;
}

function query(db, sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

function run(db, saveDb, sql, params = []) {
  db.run(sql, params);
  saveDb();
}

function runStep(db, sql, params = []) {
  db.run(sql, params);
}

function runTransaction(db, saveDb, task) {
  db.run("BEGIN TRANSACTION");
  try {
    const result = task();
    db.run("COMMIT");
    saveDb();
    return result;
  } catch (error) {
    try {
      db.run("ROLLBACK");
    } catch {}
    throw error;
  }
}

export function createConversationStore(db, saveDb = () => {}) {
  return {
    initSchema() {
      db.run(`
        CREATE TABLE IF NOT EXISTS conversations (
          id TEXT PRIMARY KEY,
          title TEXT DEFAULT 'New App',
          project_dir TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      ensureColumn(db, "conversations", "project_dir", "TEXT");
      db.run(`
        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT,
          build_id TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (conversation_id) REFERENCES conversations(id)
        )
      `);
      db.run(`
        CREATE TABLE IF NOT EXISTS conversation_files (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_id TEXT NOT NULL,
          build_id TEXT NOT NULL,
          filename TEXT NOT NULL,
          content TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (conversation_id) REFERENCES conversations(id)
        )
      `);
      db.run(`
        CREATE TABLE IF NOT EXISTS project_memory (
          conversation_id TEXT PRIMARY KEY,
          memory_json TEXT NOT NULL,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (conversation_id) REFERENCES conversations(id)
        )
      `);
    },

    listConversations() {
      return query(db, "SELECT * FROM conversations ORDER BY updated_at DESC");
    },

    createConversation(id = crypto.randomUUID(), title = "New App", options = {}) {
      const projectDir = String(options.projectDir || options.project_dir || "").trim();
      run(db, saveDb, "INSERT INTO conversations (id, title, project_dir) VALUES (?, ?, ?)", [id, title, projectDir]);
      return { id, title, project_dir: projectDir };
    },

    updateConversation(id, patch = {}) {
      const title = patch.title == null ? null : String(patch.title || "").trim();
      const projectDir = patch.projectDir ?? patch.project_dir;
      runTransaction(db, saveDb, () => {
        if (title) runStep(db, "UPDATE conversations SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [title, id]);
        if (projectDir != null) {
          runStep(db, "UPDATE conversations SET project_dir = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [String(projectDir || ""), id]);
        }
      });
      return this.getConversation(id);
    },

    getConversation(id) {
      const rows = query(db, "SELECT * FROM conversations WHERE id = ?", [id]);
      return rows[0] || null;
    },

    deleteConversation(id) {
      runTransaction(db, saveDb, () => {
        runStep(db, "DELETE FROM project_memory WHERE conversation_id = ?", [id]);
        runStep(db, "DELETE FROM conversation_files WHERE conversation_id = ?", [id]);
        runStep(db, "DELETE FROM messages WHERE conversation_id = ?", [id]);
        runStep(db, "DELETE FROM conversations WHERE id = ?", [id]);
      });
    },

    listMessages(conversationId) {
      return query(db, "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC", [conversationId]);
    },

    appendMessage(conversationId, message = {}) {
      const role = message.role;
      const content = message.content;
      const buildId = message.build_id || null;
      runTransaction(db, saveDb, () => {
        runStep(
          db,
          "INSERT INTO messages (conversation_id, role, content, build_id) VALUES (?, ?, ?, ?)",
          [conversationId, role, content, buildId]
        );
        if (role === "user") {
          const msgCount = query(db, "SELECT COUNT(*) as count FROM messages WHERE conversation_id = ?", [conversationId]);
          if (msgCount[0]?.count === 1) {
            const title = String(content || "").slice(0, 50) + (String(content || "").length > 50 ? "..." : "");
            runStep(db, "UPDATE conversations SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [title, conversationId]);
          }
        }
      });
    },

    saveConversationFiles(conversationId, buildId, files) {
      const safeFiles = filterConversationFiles(files);
      const serialized = serializeFileMap(safeFiles);
      runTransaction(db, saveDb, () => {
        runStep(db, "DELETE FROM conversation_files WHERE conversation_id = ?", [conversationId]);
        for (const [filename, content] of Object.entries(serialized)) {
          runStep(
            db,
            "INSERT INTO conversation_files (conversation_id, build_id, filename, content) VALUES (?, ?, ?, ?)",
            [conversationId, buildId, filename, typeof content === "string" ? content : JSON.stringify(content)]
          );
        }
      });
    },

    loadConversationFiles(conversationId) {
      const rows = query(db, "SELECT filename, content, build_id FROM conversation_files WHERE conversation_id = ? ORDER BY id ASC", [conversationId]);
      if (rows.length === 0) return { buildId: null, files: {} };
      const files = {};
      for (const row of rows) {
        if (CONVERSATION_FILE_NAMES.has(row.filename)) {
          files[row.filename] = row.content;
          continue;
        }
        const content = parseStoredFileContent(row.content);
        const candidate = { ...files, [row.filename]: content };
        if (declaredAssetPathsFromFiles(candidate).includes(row.filename)) {
          files[row.filename] = content;
        }
      }
      return { buildId: rows[0].build_id, files: deserializeFileMap(files) };
    },

    deleteConversationFiles(conversationId) {
      run(db, saveDb, "DELETE FROM conversation_files WHERE conversation_id = ?", [conversationId]);
    },

    getProjectMemory(conversationId) {
      const rows = query(db, "SELECT memory_json FROM project_memory WHERE conversation_id = ?", [conversationId]);
      if (!rows.length) return defaultProjectMemory();
      try {
        return normalizeProjectMemory(JSON.parse(rows[0].memory_json));
      } catch {
        return defaultProjectMemory();
      }
    },

    setProjectMemory(conversationId, memory = {}) {
      const normalized = normalizeProjectMemory(memory);
      const serialized = JSON.stringify(normalized);
      runTransaction(db, saveDb, () => {
        runStep(
          db,
          `INSERT INTO project_memory (conversation_id, memory_json, updated_at)
           VALUES (?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(conversation_id) DO UPDATE SET memory_json = ?, updated_at = CURRENT_TIMESTAMP`,
          [conversationId, serialized, serialized]
        );
        runStep(db, "UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", [conversationId]);
      });
      return normalized;
    }
  };
}

function ensureColumn(db, table, column, type) {
  const rows = query(db, `PRAGMA table_info(${table})`);
  if (rows.some(row => row.name === column)) return;
  db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

export function defaultProjectMemory() {
  return {
    summary: "",
    goal: "",
    requirements: [],
    constraints: [],
    open_questions: [],
    decisions: [],
    build_prompt: "",
  };
}

export function normalizeProjectMemory(memory = {}) {
  const base = defaultProjectMemory();
  return {
    summary: stringValue(memory.summary || base.summary),
    goal: stringValue(memory.goal || base.goal),
    requirements: stringList(memory.requirements),
    constraints: stringList(memory.constraints),
    open_questions: stringList(memory.open_questions),
    decisions: stringList(memory.decisions),
    build_prompt: stringValue(memory.build_prompt || base.build_prompt),
  };
}

function stringValue(value) {
  return String(value || "").trim();
}

function stringList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => String(item || "").trim()).filter(Boolean))].slice(0, 20);
}

function parseStoredFileContent(value) {
  if (typeof value !== "string") return value;
  try {
    const parsed = JSON.parse(value);
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed.__vibeboardFileEncoding === "base64" || parsed.type === "Buffer")
    ) {
      return parsed;
    }
  } catch {}
  return value;
}
