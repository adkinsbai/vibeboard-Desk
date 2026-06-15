const SCHEMA = `
CREATE TABLE IF NOT EXISTS playbooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signature TEXT NOT NULL UNIQUE,
  task_type TEXT NOT NULL DEFAULT 'general',
  title TEXT,
  root_cause TEXT,
  diagnosis_steps TEXT DEFAULT '[]',
  fix TEXT,
  verification_evidence TEXT DEFAULT '[]',
  tags TEXT DEFAULT '[]',
  score REAL DEFAULT 1,
  usage_count INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  last_used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_playbooks_task_type ON playbooks(task_type);
CREATE INDEX IF NOT EXISTS idx_playbooks_score ON playbooks(score);
CREATE INDEX IF NOT EXISTS idx_playbooks_updated_at ON playbooks(updated_at);
`;

const MAX_SIGNATURE_PARTS = 5;
const MAX_SIGNATURE_TEXT = 120;

function save(saveDb) {
  if (typeof saveDb === "function") saveDb();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeText(value, fallback = "") {
  const text = value == null ? "" : String(value).trim();
  return text || fallback;
}

function normalizeKey(value) {
  return normalizeText(value, "general")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48) || "general";
}

function normalizeSignatureText(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[a-z]:\\[^\s"'`]+/gi, "<path>")
    .replace(/\/[^\s"'`]+/g, "<path>")
    .replace(/\bvb-[a-z0-9-]+\b/g, "<build_id>")
    .replace(/:\d+:\d+/g, ":line")
    .replace(/\s+/g, " ")
    .slice(0, MAX_SIGNATURE_TEXT)
    .trim();
}

function issueMessage(issue) {
  if (issue == null) return "";
  if (typeof issue === "string") return issue;
  if (typeof issue === "number" || typeof issue === "boolean") return String(issue);

  const direct =
    issue.message ||
    issue.summary ||
    issue.text ||
    issue.detail ||
    issue.error ||
    issue.reason ||
    issue.description;

  if (direct) return String(direct);

  try {
    return JSON.stringify(issue);
  } catch {
    return "";
  }
}

function issuePart(issue) {
  if (issue == null) return "";
  if (typeof issue !== "object") return normalizeSignatureText(issue);

  const phase = normalizeKey(issue.phase || issue.tool || issue.category || issue.source);
  const code = normalizeKey(issue.code || issue.type || issue.name || issue.severity);
  const message = normalizeSignatureText(issueMessage(issue));

  return [phase, code, message].filter(Boolean).join(":");
}

function normalizeList(value) {
  const input = Array.isArray(value) ? value : value == null ? [] : [value];
  const out = [];
  const seen = new Set();

  for (const item of input.flat()) {
    const text = normalizeText(item);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }

  return out;
}

function parseList(value) {
  if (Array.isArray(value)) return normalizeList(value);

  try {
    return normalizeList(JSON.parse(value || "[]"));
  } catch {
    return [];
  }
}

function mergeLists(...lists) {
  return normalizeList(lists.flatMap(list => parseList(list)));
}

function toJsonList(value) {
  return JSON.stringify(normalizeList(value));
}

function rowsFromExec(result) {
  if (!result.length || !result[0].values) return [];
  const columns = result[0].columns;

  return result[0].values.map(row => {
    const obj = {};
    columns.forEach((column, index) => {
      obj[column] = row[index];
    });
    return normalizeRow(obj);
  });
}

function normalizeRow(row) {
  if (!row) return null;

  return {
    ...row,
    diagnosis_steps: parseList(row.diagnosis_steps),
    verification_evidence: parseList(row.verification_evidence),
    tags: parseList(row.tags),
    score: Number(row.score || 0),
    usage_count: Number(row.usage_count || 0),
    success_count: Number(row.success_count || 0),
    failure_count: Number(row.failure_count || 0),
  };
}

function getBySignature(db, signature) {
  const rows = db.exec(
    `SELECT * FROM playbooks WHERE signature = ? LIMIT 1`,
    [signature]
  );
  return rowsFromExec(rows)[0] || null;
}

function tokenSet(value) {
  return new Set(
    normalizeSignatureText(value)
      .split(/[^a-z0-9]+/)
      .filter(token => token.length >= 3)
  );
}

function tokenOverlapScore(left, right) {
  const leftTokens = tokenSet(left);
  const rightTokens = tokenSet(right);
  if (!leftTokens.size || !rightTokens.size) return 0;

  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }

  return overlap / Math.max(leftTokens.size, rightTokens.size);
}

function numeric(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeRecordInput(input = {}) {
  const issues = input.issues || input.verificationIssues || [];
  const signature = normalizeText(input.signature) || signatureFromIssues(issues);
  const rootCause = normalizeText(input.rootCause || input.root_cause);
  const diagnosisSteps = normalizeList(input.diagnosisSteps || input.diagnosis_steps);
  const verificationEvidence = normalizeList(input.verificationEvidence || input.verification_evidence);

  return {
    signature,
    taskType: normalizeText(input.taskType || input.task_type, "general"),
    title: normalizeText(input.title || input.promptSummary || input.prompt_summary || signature),
    rootCause,
    diagnosisSteps,
    fix: normalizeText(input.fix || input.fixesApplied || input.fixes_applied),
    verificationEvidence,
    tags: normalizeList(input.tags),
    score: clamp(numeric(input.score, 1), 0, 100),
  };
}

export function signatureFromIssues(issues) {
  const source = Array.isArray(issues)
    ? issues
    : issues && typeof issues === "object" && Array.isArray(issues.issues)
      ? issues.issues
      : issues == null
        ? []
        : [issues];

  const parts = source
    .map(issuePart)
    .filter(Boolean)
    .slice(0, MAX_SIGNATURE_PARTS);

  if (!parts.length) return "general:unknown";
  return `issues:${parts.join("||")}`;
}

export function createPlaybookStore(db, saveDb) {
  function initSchema() {
    db.exec(SCHEMA);
    save(saveDb);
  }

  function recordPlaybook(input = {}) {
    const normalized = normalizeRecordInput(input);
    const existing = getBySignature(db, normalized.signature);

    if (existing) {
      const diagnosisSteps = mergeLists(existing.diagnosis_steps, normalized.diagnosisSteps);
      const verificationEvidence = mergeLists(existing.verification_evidence, normalized.verificationEvidence);
      const tags = mergeLists(existing.tags, normalized.tags);
      const score = clamp(Math.max(existing.score, normalized.score) + Math.max(0.1, normalized.score * 0.2), 0, 100);

      db.run(
        `UPDATE playbooks
         SET task_type = CASE WHEN task_type = 'general' THEN ? ELSE task_type END,
             title = CASE WHEN ? = '' THEN title ELSE ? END,
             root_cause = CASE WHEN ? = '' THEN root_cause ELSE ? END,
             diagnosis_steps = ?,
             fix = CASE WHEN ? = '' THEN fix ELSE ? END,
             verification_evidence = ?,
             tags = ?,
             score = ?,
             updated_at = datetime('now')
         WHERE signature = ?`,
        [
          normalized.taskType,
          normalized.title,
          normalized.title,
          normalized.rootCause,
          normalized.rootCause,
          JSON.stringify(diagnosisSteps),
          normalized.fix,
          normalized.fix,
          JSON.stringify(verificationEvidence),
          JSON.stringify(tags),
          score,
          normalized.signature,
        ]
      );
    } else {
      db.run(
        `INSERT INTO playbooks (
           signature,
           task_type,
           title,
           root_cause,
           diagnosis_steps,
           fix,
           verification_evidence,
           tags,
           score
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          normalized.signature,
          normalized.taskType,
          normalized.title,
          normalized.rootCause,
          JSON.stringify(normalized.diagnosisSteps),
          normalized.fix,
          JSON.stringify(normalized.verificationEvidence),
          JSON.stringify(normalized.tags),
          normalized.score,
        ]
      );
    }

    save(saveDb);
    return getBySignature(db, normalized.signature);
  }

  function findPlaybooks(query = {}, maybeLimit = undefined) {
    const criteria = Array.isArray(query)
      ? { issues: query, limit: maybeLimit }
      : typeof query === "string"
        ? { signature: query, limit: maybeLimit }
        : { ...query };

    const signature = normalizeText(criteria.signature) ||
      (criteria.issues || criteria.verificationIssues ? signatureFromIssues(criteria.issues || criteria.verificationIssues) : "");
    const taskType = normalizeText(criteria.taskType || criteria.task_type, "general");
    const limit = clamp(Math.trunc(numeric(criteria.limit, maybeLimit || 5)), 1, 50);
    const minScore = numeric(criteria.minScore ?? criteria.min_score, 0);

    const rows = rowsFromExec(db.exec(
      `SELECT * FROM playbooks
       WHERE score >= ? AND (task_type = ? OR task_type = 'general')
       ORDER BY score DESC, updated_at DESC
       LIMIT 100`,
      [minScore, taskType]
    ));

    return rows
      .map(row => {
        const exact = signature && row.signature === signature;
        const overlap = signature ? tokenOverlapScore(signature, row.signature) : 0;
        return {
          ...row,
          match_score: row.score + (exact ? 100 : overlap * 10),
          exact_match: Boolean(exact),
        };
      })
      .filter(row => !signature || row.exact_match || row.match_score > row.score)
      .sort((left, right) => right.match_score - left.match_score || right.score - left.score)
      .slice(0, limit);
  }

  function recordUse(signatureOrInput, meta = {}) {
    const input = typeof signatureOrInput === "string"
      ? { signature: signatureOrInput, ...meta }
      : { ...signatureOrInput, ...meta };
    const signature = normalizeText(input.signature) || signatureFromIssues(input.issues || input.verificationIssues);
    const existing = getBySignature(db, signature) || recordPlaybook({ ...input, signature });
    const success = input.success === true;
    const failed = input.success === false;
    const delta = Number.isFinite(Number(input.scoreDelta))
      ? Number(input.scoreDelta)
      : success
        ? 0.5
        : failed
          ? -0.25
          : 0.1;
    const verificationEvidence = mergeLists(existing.verification_evidence, input.verificationEvidence || input.verification_evidence || input.evidence);
    const score = clamp(existing.score + delta, 0, 100);

    db.run(
      `UPDATE playbooks
       SET usage_count = usage_count + 1,
           success_count = success_count + ?,
           failure_count = failure_count + ?,
           verification_evidence = ?,
           score = ?,
           updated_at = datetime('now'),
           last_used_at = datetime('now')
       WHERE signature = ?`,
      [
        success ? 1 : 0,
        failed ? 1 : 0,
        JSON.stringify(verificationEvidence),
        score,
        signature,
      ]
    );

    save(saveDb);
    return getBySignature(db, signature);
  }

  return {
    initSchema,
    recordPlaybook,
    findPlaybooks,
    recordUse,
    signatureFromIssues,
  };
}
