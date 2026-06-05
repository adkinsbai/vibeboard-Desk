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
    },

    listConversations() {
      return query(db, "SELECT * FROM conversations ORDER BY updated_at DESC");
    },

    createConversation(id = crypto.randomUUID(), title = "New App") {
      run(db, saveDb, "INSERT INTO conversations (id, title) VALUES (?, ?)", [id, title]);
      return { id, title };
    },

    deleteConversation(id) {
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
    }
  };
}
