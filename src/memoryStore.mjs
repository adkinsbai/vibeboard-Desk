/**
 * Memory Store — 用户偏好记忆系统
 *
 * 从对话历史中自动提取用户偏好，持久化到 SQLite，
 * 每次生成前注入到 agent 系统提示。
 *
 * 偏好类型：
 * - style: 整体风格（简约/科技感/可爱/复古）
 * - color_scheme: 配色方案（深色/浅色/自定义）
 * - palette: 具体颜色值（JSON 数组）
 * - font: 偏好字体
 * - layout: 布局偏好（卡片/列表/仪表盘）
 * - device: 硬件设备信息
 * - app_types: 常用应用类型（时钟/天气/监控...）
 */

// 偏好 schema 定义
const PREFERENCE_SCHEMA = {
  style: { label: "风格", examples: ["简约", "科技感", "可爱", "复古", "苹果风", "暗黑"] },
  color_scheme: { label: "配色", examples: ["深色", "浅色", "暖色", "冷色"] },
  palette: { label: "调色板", examples: ["#0a0f1a,#111827,#38bdf8"] },
  font: { label: "字体", examples: ["system-ui", "SF Pro", "monospace"] },
  layout: { label: "布局", examples: ["卡片式", "仪表盘", "列表", "全屏"] },
  device: { label: "设备", examples: ["泰山派", "绑定设备"] },
  app_types: { label: "常用类型", examples: ["时钟", "天气", "监控", "轮播"] },
};

/**
 * 创建记忆存储
 * @param {Object} db - sql.js 数据库实例
 * @param {Function} saveDb - 保存数据库到磁盘
 */
export function createMemoryStore(db, saveDb = () => {}) {
  function query(sql, params = []) {
    const stmt = db.prepare(sql);
    if (params.length) stmt.bind(params);
    const results = [];
    while (stmt.step()) results.push(stmt.getAsObject());
    stmt.free();
    return results;
  }

  function run(sql, params = []) {
    db.run(sql, params);
    saveDb();
  }

  return {
    /**
     * 初始化数据库表
     */
    initSchema() {
      db.run(`
        CREATE TABLE IF NOT EXISTS user_preferences (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      db.run(`
        CREATE TABLE IF NOT EXISTS app_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_id TEXT,
          app_type TEXT,
          name TEXT,
          description TEXT,
          css_variables TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
    },

    /**
     * 获取所有偏好
     * @returns {Object} 偏好键值对
     */
    getAll() {
      const rows = query("SELECT key, value FROM user_preferences");
      const prefs = {};
      for (const row of rows) {
        try {
          prefs[row.key] = JSON.parse(row.value);
        } catch {
          prefs[row.key] = row.value;
        }
      }
      return prefs;
    },

    /**
     * 获取单个偏好
     * @param {string} key
     * @returns {*} 值
     */
    get(key) {
      const rows = query("SELECT value FROM user_preferences WHERE key = ?", [key]);
      if (rows.length === 0) return null;
      try { return JSON.parse(rows[0].value); } catch { return rows[0].value; }
    },

    /**
     * 设置偏好
     * @param {string} key
     * @param {*} value
     */
    set(key, value) {
      const serialized = typeof value === "string" ? value : JSON.stringify(value);
      run(
        `INSERT INTO user_preferences (key, value, updated_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP`,
        [key, serialized, serialized]
      );
    },

    /**
     * 删除偏好
     * @param {string} key
     */
    remove(key) {
      run("DELETE FROM user_preferences WHERE key = ?", [key]);
    },

    /**
     * 记录应用历史（用于分析偏好）
     */
    recordApp(conversationId, appType, name, description, cssVariables = null) {
      run(
        `INSERT INTO app_history (conversation_id, app_type, name, description, css_variables)
         VALUES (?, ?, ?, ?, ?)`,
        [conversationId, appType, name, description, cssVariables]
      );
    },

    /**
     * 获取最近的应用历史
     * @param {number} limit
     * @returns {Array}
     */
    getRecentApps(limit = 20) {
      return query(
        "SELECT * FROM app_history ORDER BY created_at DESC LIMIT ?",
        [limit]
      );
    },

    /**
     * 从对话中自动提取偏好
     * @param {string} userPrompt - 用户的请求
     * @param {Object} generatedFiles - 生成的代码文件
     * @param {string} appType - 应用类型
     */
    extractPreferences(userPrompt, generatedFiles = {}, appType = null) {
      // 提取应用类型
      if (appType) {
        const types = this.get("app_types") || [];
        if (!types.includes(appType)) {
          types.push(appType);
          if (types.length > 10) types.shift(); // 最多保留 10 个
          this.set("app_types", types);
        }
      }

      // 从 CSS 中提取配色
      const css = generatedFiles["style.css"] || "";
      if (css) {
        const colors = [];
        const colorRegex = /#[0-9a-fA-F]{3,8}/g;
        const matches = css.match(colorRegex);
        if (matches) {
          // 取出现频率最高的颜色
          const freq = {};
          for (const c of matches) {
            freq[c] = (freq[c] || 0) + 1;
          }
          const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]);
          colors.push(...sorted.slice(0, 5).map(([c]) => c));
        }
        if (colors.length > 0) {
          this.set("palette", colors);
        }

        // 检测深色/浅色主题
        const bgMatch = css.match(/(?:background|bg)[^;]*?#[0-9a-fA-F]{3,8}/i);
        if (bgMatch) {
          const hex = bgMatch[0].match(/#[0-9a-fA-F]{3,8}/)?.[0];
          if (hex) {
            const brightness = hexBrightness(hex);
            this.set("color_scheme", brightness < 128 ? "深色" : "浅色");
          }
        }
      }

      // 从用户消息提取风格关键词
      const styleKeywords = {
        "简约": "简约", "简洁": "简约", "简单": "简约", "minimal": "简约",
        "科技": "科技感", "未来": "科技感", "赛博": "科技感", "tech": "科技感",
        "可爱": "可爱", "萌": "可爱", "cute": "可爱",
        "复古": "复古", "retro": "复古", "怀旧": "复古",
        "苹果": "苹果风", "apple": "苹果风", "iOS": "苹果风",
        "暗黑": "暗黑", "dark": "暗黑",
      };
      for (const [keyword, style] of Object.entries(styleKeywords)) {
        if (userPrompt.includes(keyword)) {
          this.set("style", style);
          break;
        }
      }
    },

    /**
     * 将偏好格式化为注入 agent 系统提示的文本
     * @returns {string}
     */
    formatForPrompt() {
      const prefs = this.getAll();
      if (Object.keys(prefs).length === 0) return "";

      const lines = ["## 用户偏好记忆"];
      for (const [key, value] of Object.entries(prefs)) {
        const schema = PREFERENCE_SCHEMA[key];
        const label = schema?.label || key;
        const display = Array.isArray(value) ? value.join(", ") : String(value);
        lines.push(`- ${label}: ${display}`);
      }
      return lines.join("\n");
    },

    /**
     * 获取偏好 schema（供前端使用）
     */
    getSchema() {
      return PREFERENCE_SCHEMA;
    },
  };
}

/**
 * 计算 hex 颜色的亮度
 */
function hexBrightness(hex) {
  hex = hex.replace("#", "");
  if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000;
}
