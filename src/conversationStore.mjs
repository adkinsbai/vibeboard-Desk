import crypto from "node:crypto";

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

export function createConversationStore(db, saveDb = () => {}) {
  return {
    initSchema() {
      db.run(`
        CREATE TABLE IF NOT EXISTS conversations (
          id TEXT PRIMARY KEY,
          title TEXT DEFAULT 'New App',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
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

    createConversation(id = crypto.randomUUID(), title = "New App") {
      run(db, saveDb, "INSERT INTO conversations (id, title) VALUES (?, ?)", [id, title]);
      return { id, title };
    },

    deleteConversation(id) {
      run(db, saveDb, "DELETE FROM project_memory WHERE conversation_id = ?", [id]);
      run(db, saveDb, "DELETE FROM conversation_files WHERE conversation_id = ?", [id]);
      run(db, saveDb, "DELETE FROM messages WHERE conversation_id = ?", [id]);
      run(db, saveDb, "DELETE FROM conversations WHERE id = ?", [id]);
    },

    listMessages(conversationId) {
      return query(db, "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC", [conversationId]);
    },

    appendMessage(conversationId, message = {}) {
      const role = message.role;
      const content = message.content;
      const buildId = message.build_id || null;
      run(
        db,
        saveDb,
        "INSERT INTO messages (conversation_id, role, content, build_id) VALUES (?, ?, ?, ?)",
        [conversationId, role, content, buildId]
      );
      if (role === "user") {
        const msgCount = query(db, "SELECT COUNT(*) as count FROM messages WHERE conversation_id = ?", [conversationId]);
        if (msgCount[0]?.count === 1) {
          const title = String(content || "").slice(0, 50) + (String(content || "").length > 50 ? "..." : "");
          run(db, saveDb, "UPDATE conversations SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [title, conversationId]);
        }
      }
    },

    saveConversationFiles(conversationId, buildId, files) {
      // Clear old files for this conversation
      run(db, saveDb, "DELETE FROM conversation_files WHERE conversation_id = ?", [conversationId]);
      // Save new files
      for (const [filename, content] of Object.entries(files || {})) {
        run(
          db,
          saveDb,
          "INSERT INTO conversation_files (conversation_id, build_id, filename, content) VALUES (?, ?, ?, ?)",
          [conversationId, buildId, filename, content]
        );
      }
    },

    loadConversationFiles(conversationId) {
      const rows = query(db, "SELECT filename, content, build_id FROM conversation_files WHERE conversation_id = ? ORDER BY id ASC", [conversationId]);
      if (rows.length === 0) return { buildId: null, files: {} };
      const files = {};
      for (const row of rows) {
        files[row.filename] = row.content;
      }
      return { buildId: rows[0].build_id, files };
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
      run(
        db,
        saveDb,
        `INSERT INTO project_memory (conversation_id, memory_json, updated_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(conversation_id) DO UPDATE SET memory_json = ?, updated_at = CURRENT_TIMESTAMP`,
        [conversationId, serialized, serialized]
      );
      run(db, saveDb, "UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", [conversationId]);
      return normalized;
    }
  };
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
