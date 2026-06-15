/**
 * Experience Store — Agent 经验记忆系统
 *
 * 存储每次构建的经验教训：
 * - 什么模式有效
 * - 什么陷阱需要避免
 * - 验证失败的原因和修复方法
 *
 * Agent 在生成新代码前查询相关经验，避免重复犯错。
 */

import { signatureFromIssues } from "./playbookStore.mjs";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS build_experiences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_type TEXT NOT NULL,
  prompt_summary TEXT,
  what_worked TEXT DEFAULT '[]',
  what_failed TEXT DEFAULT '[]',
  fixes_applied TEXT DEFAULT '[]',
  verification_result TEXT,
  success INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_experiences_task_type ON build_experiences(task_type);
CREATE INDEX IF NOT EXISTS idx_experiences_success ON build_experiences(success);
`;

function normalizeText(value, fallback = "") {
  const text = value == null ? "" : String(value).trim();
  return text || fallback;
}

function normalizeLessonItem(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value).trim();

  try {
    return JSON.stringify(value).trim();
  } catch {
    return "";
  }
}

function normalizeLessonList(value) {
  const input = Array.isArray(value) ? value : value == null ? [] : [value];
  const seen = new Set();
  const normalized = [];

  for (const item of input) {
    const text = normalizeLessonItem(item);
    if (!text || seen.has(text)) continue;

    seen.add(text);
    normalized.push(text);
  }

  return normalized;
}

function parseLessonList(value) {
  try {
    return normalizeLessonList(JSON.parse(value || "[]"));
  } catch {
    return [];
  }
}

function parseJsonValue(value, fallback = null) {
  try {
    return JSON.parse(value || "null");
  } catch {
    return fallback;
  }
}

function sameLessonList(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function addUniqueLessons(target, values) {
  for (const value of normalizeLessonList(values)) {
    if (!target.includes(value)) target.push(value);
  }
}

export function makePlaybookCandidate(experience = {}) {
  const verificationResult = experience.verification_result || experience.verificationResult || {};
  const issues = normalizeLessonList(
    verificationResult.issues ||
    experience.what_failed ||
    experience.whatFailed
  );
  const fixes = normalizeLessonList(experience.fixes_applied || experience.fixesApplied);
  const evidence = normalizeLessonList([
    verificationResult.summary,
    verificationResult.evidence,
    verificationResult.phase ? `phase: ${verificationResult.phase}` : "",
  ]);

  return {
    signature: signatureFromIssues(issues),
    taskType: normalizeText(experience.task_type || experience.taskType, "general"),
    title: normalizeText(experience.prompt_summary || experience.promptSummary || issues[0], "Experience-derived playbook"),
    rootCause: issues[0] || "",
    diagnosisSteps: issues,
    fix: fixes.join("; "),
    verificationEvidence: evidence,
    score: experience.success ? 2 : 1,
    tags: ["experience"],
  };
}

export function createExperienceStore(db, saveDb) {
  function initSchema() {
    db.exec(SCHEMA);
    saveDb();
  }

  /**
   * 记录一次构建经验
   */
  function recordExperience({ taskType, promptSummary, whatWorked = [], whatFailed = [], fixesApplied = [], verificationResult = null, success = false }) {
    const normalizedTaskType = normalizeText(taskType, "general");
    const normalizedPromptSummary = normalizeText(promptSummary);
    const normalizedWorked = normalizeLessonList(whatWorked);
    const normalizedFailed = normalizeLessonList(whatFailed);
    const normalizedFixes = normalizeLessonList(fixesApplied);
    const verificationJson = verificationResult ? JSON.stringify(verificationResult) : null;

    const latestRows = db.exec(
      `SELECT id, what_worked, what_failed, fixes_applied
       FROM build_experiences
       WHERE task_type = ? AND prompt_summary = ?
       ORDER BY id DESC
       LIMIT 1`,
      [normalizedTaskType, normalizedPromptSummary]
    );

    if (latestRows.length && latestRows[0].values.length) {
      const [id, lastWorked, lastFailed, lastFixes] = latestRows[0].values[0];
      const isDuplicate =
        sameLessonList(parseLessonList(lastWorked), normalizedWorked) &&
        sameLessonList(parseLessonList(lastFailed), normalizedFailed) &&
        sameLessonList(parseLessonList(lastFixes), normalizedFixes);

      if (isDuplicate) {
        db.run(
          `UPDATE build_experiences
           SET what_worked = ?,
               what_failed = ?,
               fixes_applied = ?,
               verification_result = CASE WHEN ? IS NULL THEN verification_result ELSE ? END,
               success = CASE WHEN success = 1 OR ? = 1 THEN 1 ELSE 0 END
           WHERE id = ?`,
          [
            JSON.stringify(normalizedWorked),
            JSON.stringify(normalizedFailed),
            JSON.stringify(normalizedFixes),
            verificationJson,
            verificationJson,
            success ? 1 : 0,
            id,
          ]
        );
        saveDb();
        return;
      }
    }

    db.run(
      `INSERT INTO build_experiences (task_type, prompt_summary, what_worked, what_failed, fixes_applied, verification_result, success)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        normalizedTaskType,
        normalizedPromptSummary,
        JSON.stringify(normalizedWorked),
        JSON.stringify(normalizedFailed),
        JSON.stringify(normalizedFixes),
        verificationJson,
        success ? 1 : 0,
      ]
    );
    saveDb();
  }

  /**
   * 查询相关经验（按任务类型）
   * 返回最近 10 条经验，优先返回成功的
   */
  function queryExperience(taskType, limit = 10) {
    const rows = db.exec(
      `SELECT * FROM build_experiences
       WHERE task_type = ? OR task_type = 'general'
       ORDER BY success DESC, created_at DESC
       LIMIT ?`,
      [taskType, limit]
    );

    if (!rows.length || !rows[0].values) return [];

    const columns = rows[0].columns;
    return rows[0].values.map(row => {
      const obj = {};
      columns.forEach((col, i) => { obj[col] = row[i]; });
      // Parse JSON fields
      obj.what_worked = parseLessonList(obj.what_worked);
      obj.what_failed = parseLessonList(obj.what_failed);
      obj.fixes_applied = parseLessonList(obj.fixes_applied);
      obj.verification_result = parseJsonValue(obj.verification_result);
      return obj;
    });
  }

  /**
   * 获取通用教训（失败经验的总结）
   */
  function getLessons(taskType, limit = 5) {
    const experiences = queryExperience(taskType, 20);

    const lessons = {
      pitfalls: [],    // 常见陷阱
      patterns: [],    // 成功模式
      fixes: [],       // 有效修复
    };

    for (const exp of experiences) {
      addUniqueLessons(lessons.pitfalls, exp.what_failed);
      addUniqueLessons(lessons.patterns, exp.what_worked);
      addUniqueLessons(lessons.fixes, exp.fixes_applied);
    }

    // 限制数量
    lessons.pitfalls = lessons.pitfalls.slice(0, limit);
    lessons.patterns = lessons.patterns.slice(0, limit);
    lessons.fixes = lessons.fixes.slice(0, limit);

    return lessons;
  }

  /**
   * 统计成功率
   */
  function getStats(taskType) {
    const rows = db.exec(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successes
       FROM build_experiences
       WHERE task_type = ? OR task_type = 'general'`,
      [taskType]
    );

    if (!rows.length || !rows[0].values.length) return { total: 0, successes: 0, rate: 0 };

    const [total, successes] = rows[0].values[0];
    return {
      total,
      successes,
      rate: total > 0 ? (successes / total * 100).toFixed(0) : 0,
    };
  }

  return {
    initSchema,
    recordExperience,
    queryExperience,
    getLessons,
    getStats,
    makePlaybookCandidate,
  };
}
