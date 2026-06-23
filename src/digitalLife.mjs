import { randomUUID } from "node:crypto";
import {
  applyAffectEvent,
  defaultBrainNeeds,
  expressionFromBrain,
  normalizeBrainNeeds,
  tickAffect,
} from "./digitalLifeAffect.mjs";
import {
  appraiseReplyWithLlm,
  buildBrainMockReply,
  buildLlmReply,
  buildPreThought,
  chooseAutonomousAction,
  cleanAssistantReply,
  fallbackReplyAppraisal,
} from "./digitalLifeBrain.mjs";
import { createCognitiveCycle } from "./digitalLifeCognition.mjs";
import {
  buildDialoguePlan,
  describeDialoguePlan,
} from "./digitalLifeDialogue.mjs";
import { buildMemoryPolicyContext } from "./digitalLifeMemoryPolicy.mjs";
import {
  buildReplyContract,
  enforceReplyContract,
} from "./digitalLifeReplyPolicy.mjs";
import {
  autonomousCandidates,
  lifePhaseFor,
  planAutonomousAction,
} from "./digitalLifeAutonomy.mjs";
import {
  buildMindSnapshot,
  chooseMindAction,
  createMindKernel,
  deriveMindAffectEvent,
  MIND_KERNEL_VERSION,
} from "./digitalLifeMind.mjs";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS digital_life_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL DEFAULT 'Vibe',
  mood TEXT NOT NULL DEFAULT 'calm',
  energy INTEGER NOT NULL DEFAULT 70,
  presence TEXT NOT NULL DEFAULT '{}',
  traits TEXT NOT NULL DEFAULT '[]',
  goals TEXT NOT NULL DEFAULT '[]',
  summary TEXT NOT NULL DEFAULT '',
  needs TEXT NOT NULL DEFAULT '{}',
  loop_enabled INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT,
  last_tick_at TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS digital_life_memories (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'note',
  title TEXT,
  content TEXT NOT NULL,
  importance INTEGER NOT NULL DEFAULT 3,
  tags TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'user',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS digital_life_journal (
  id TEXT PRIMARY KEY,
  entry_type TEXT NOT NULL DEFAULT 'journal',
  title TEXT,
  content TEXT NOT NULL,
  mood TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS digital_life_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS digital_life_rewards (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  reward REAL NOT NULL DEFAULT 0,
  reason TEXT,
  state_delta TEXT NOT NULL DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS digital_life_actions (
  id TEXT PRIMARY KEY,
  action_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'done',
  input TEXT NOT NULL DEFAULT '{}',
  output TEXT NOT NULL DEFAULT '{}',
  reward REAL NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS digital_life_observations (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL DEFAULT 'owner',
  content TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'conversation',
  salience REAL NOT NULL DEFAULT 0.5,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS digital_life_concepts (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  summary TEXT NOT NULL,
  abstraction_level INTEGER NOT NULL DEFAULT 1,
  confidence REAL NOT NULL DEFAULT 0.3,
  evidence TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS digital_life_hypotheses (
  id TEXT PRIMARY KEY,
  statement TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.35,
  evidence TEXT NOT NULL DEFAULT '[]',
  counter_evidence TEXT NOT NULL DEFAULT '[]',
  next_test TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  updated_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS digital_life_beliefs (
  id TEXT PRIMARY KEY,
  belief TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.4,
  scope TEXT NOT NULL DEFAULT 'owner',
  evidence TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS digital_life_experiments (
  id TEXT PRIMARY KEY,
  question TEXT NOT NULL,
  hypothesis_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_digital_life_memories_updated_at ON digital_life_memories(updated_at);
CREATE INDEX IF NOT EXISTS idx_digital_life_journal_created_at ON digital_life_journal(created_at);
CREATE INDEX IF NOT EXISTS idx_digital_life_messages_conversation ON digital_life_messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_digital_life_rewards_created_at ON digital_life_rewards(created_at);
CREATE INDEX IF NOT EXISTS idx_digital_life_actions_created_at ON digital_life_actions(created_at);
CREATE INDEX IF NOT EXISTS idx_digital_life_observations_created_at ON digital_life_observations(created_at);
CREATE INDEX IF NOT EXISTS idx_digital_life_concepts_updated_at ON digital_life_concepts(updated_at);
CREATE INDEX IF NOT EXISTS idx_digital_life_hypotheses_updated_at ON digital_life_hypotheses(updated_at);
CREATE INDEX IF NOT EXISTS idx_digital_life_beliefs_updated_at ON digital_life_beliefs(updated_at);
`;

const DEFAULT_STATE = {
  name: "Vibe",
  mood: "calm",
  energy: 70,
  presence: {
    status: "offline-ready",
    activity: "idle",
    context: "",
  },
  traits: ["curious", "helpful", "reflective"],
  goals: ["remember useful context", "respond consistently"],
  summary: "A local-first digital life companion for the VibeBoard prototype.",
  needs: defaultBrainNeeds(),
  loop_enabled: 0,
  last_seen_at: null,
  last_tick_at: null,
};

function save(saveDb) {
  if (typeof saveDb === "function") saveDb();
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function normalizeText(value, fallback = "") {
  const text = value == null ? "" : String(value).trim();
  return text || fallback;
}

function normalizeList(value, limit = 20) {
  const input = Array.isArray(value) ? value : value == null ? [] : [value];
  const seen = new Set();
  const out = [];
  for (const item of input.flat()) {
    const text = normalizeText(item);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value || "null") ?? fallback;
  } catch {
    return fallback;
  }
}

function stringifyJson(value, fallback) {
  try {
    return JSON.stringify(value ?? fallback);
  } catch {
    return JSON.stringify(fallback);
  }
}

function rowFromExec(result) {
  if (!result.length || !result[0].values.length) return null;
  const columns = result[0].columns;
  const values = result[0].values[0];
  return Object.fromEntries(columns.map((column, index) => [column, values[index]]));
}

function rowsFromExec(result) {
  if (!result.length || !result[0].values.length) return [];
  const columns = result[0].columns;
  return result[0].values.map(values => Object.fromEntries(columns.map((column, index) => [column, values[index]])));
}

function normalizeState(row = {}) {
  const needs = normalizeBrainNeeds(parseJson(row.needs, DEFAULT_STATE.needs));
  const state = {
    name: normalizeText(row.name, DEFAULT_STATE.name),
    mood: normalizeText(row.mood, DEFAULT_STATE.mood),
    energy: clampNumber(row.energy, 0, 100, DEFAULT_STATE.energy),
    presence: {
      ...DEFAULT_STATE.presence,
      ...parseJson(row.presence, {}),
    },
    traits: normalizeList(parseJson(row.traits, DEFAULT_STATE.traits)),
    goals: normalizeList(parseJson(row.goals, DEFAULT_STATE.goals)),
    summary: normalizeText(row.summary, DEFAULT_STATE.summary),
    needs,
    affect: needs.affect,
    personality: needs.personality,
    brain: needs.brain,
    expression: expressionFromBrain(needs),
    loop_enabled: Number(row.loop_enabled || 0) === 1,
    last_seen_at: row.last_seen_at || null,
    last_tick_at: row.last_tick_at || null,
    updated_at: row.updated_at || null,
  };
  state.mind = buildMindSnapshot({ state });
  return state;
}

function clampFloat(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function normalizeReward(row = {}) {
  return {
    id: row.id,
    event_type: normalizeText(row.event_type),
    reward: Number(row.reward || 0),
    reason: normalizeText(row.reason),
    state_delta: parseJson(row.state_delta, {}),
    created_at: row.created_at,
  };
}

function normalizeAction(row = {}) {
  return {
    id: row.id,
    action_type: normalizeText(row.action_type),
    status: normalizeText(row.status, "done"),
    input: parseJson(row.input, {}),
    output: parseJson(row.output, {}),
    reward: Number(row.reward || 0),
    created_at: row.created_at,
  };
}

function normalizeObservation(row = {}) {
  return {
    id: row.id,
    subject: normalizeText(row.subject, "owner"),
    content: normalizeText(row.content),
    source: normalizeText(row.source, "conversation"),
    salience: clampFloat(row.salience, 0, 1, 0.5),
    metadata: parseJson(row.metadata, {}),
    created_at: row.created_at,
  };
}

function normalizeConcept(row = {}) {
  return {
    id: row.id,
    label: normalizeText(row.label),
    summary: normalizeText(row.summary),
    abstraction_level: clampNumber(row.abstraction_level, 1, 5, 1),
    confidence: clampFloat(row.confidence, 0, 1, 0.3),
    evidence: normalizeList(parseJson(row.evidence, []), 20),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizeHypothesis(row = {}) {
  return {
    id: row.id,
    statement: normalizeText(row.statement),
    confidence: clampFloat(row.confidence, 0, 1, 0.35),
    evidence: normalizeList(parseJson(row.evidence, []), 20),
    counter_evidence: normalizeList(parseJson(row.counter_evidence, []), 20),
    next_test: normalizeText(row.next_test),
    status: normalizeText(row.status, "active"),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizeBelief(row = {}) {
  return {
    id: row.id,
    belief: normalizeText(row.belief),
    confidence: clampFloat(row.confidence, 0, 1, 0.4),
    scope: normalizeText(row.scope, "owner"),
    evidence: normalizeList(parseJson(row.evidence, []), 20),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizeExperiment(row = {}) {
  return {
    id: row.id,
    question: normalizeText(row.question),
    hypothesis_id: normalizeText(row.hypothesis_id),
    status: normalizeText(row.status, "pending"),
    result: normalizeText(row.result),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizeMemory(row = {}) {
  return {
    id: row.id,
    kind: normalizeText(row.kind, "note"),
    title: normalizeText(row.title),
    content: normalizeText(row.content),
    importance: clampNumber(row.importance, 1, 5, 3),
    tags: normalizeList(parseJson(row.tags, [])),
    source: normalizeText(row.source, "user"),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizeJournal(row = {}) {
  return {
    id: row.id,
    entry_type: normalizeText(row.entry_type, "journal"),
    title: normalizeText(row.title),
    content: normalizeText(row.content),
    mood: normalizeText(row.mood),
    tags: normalizeList(parseJson(row.tags, [])),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizeMessage(row = {}) {
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    role: row.role,
    content: row.content,
    metadata: parseJson(row.metadata, {}),
    created_at: row.created_at,
  };
}

function containsAny(text, words) {
  const normalized = text.toLowerCase();
  return words.some(word => normalized.includes(word));
}

function extractMemoryCandidate(content) {
  const text = normalizeText(content);
  if (!text) return null;
  const lower = text.toLowerCase();
  const markers = ["remember", "记住", "偏好", "我喜欢", "我希望", "以后"];
  if (!markers.some(marker => lower.includes(marker.toLowerCase()))) return null;
  return {
    kind: "conversation",
    title: text.slice(0, 48),
    content: text,
    importance: containsAny(text, ["重要", "must", "always", "必须"]) ? 5 : 3,
    tags: ["conversation"],
    source: "message",
  };
}

function confidenceBump(current, amount) {
  return clampFloat(Number(current || 0) + amount, 0.05, 0.98, 0.4);
}

function buildMockReply({ content, state, memories }) {
  const text = normalizeText(content);
  const memoryHint = memories[0]?.content ? ` I also remember: ${memories[0].content.slice(0, 120)}` : "";
  if (!text) return `I am here in ${state.mood} mode.${memoryHint}`;
  if (containsAny(text, ["reflection", "反思", "总结"])) {
    return `Reflection noted. I see the current thread as: ${text.slice(0, 160)}${memoryHint}`;
  }
  if (containsAny(text, ["状态", "presence", "你在吗", "alive"])) {
    return `I am ${state.presence.status || "present"}, energy ${state.energy}/100, mood ${state.mood}.${memoryHint}`;
  }
  return `Offline mock response: I heard "${text.slice(0, 180)}". I will keep this in local memory when it looks useful.${memoryHint}`;
}

function createReflection({ state, recentMessages, memories }) {
  const userMessages = recentMessages.filter(message => message.role === "user");
  const latest = userMessages[userMessages.length - 1]?.content || "";
  const importantMemory = memories.find(memory => memory.importance >= 4);
  return [
    `Mood: ${state.mood}; energy: ${state.energy}/100.`,
    latest ? `Recent focus: ${latest.slice(0, 180)}` : "Recent focus: no active conversation yet.",
    importantMemory ? `Important memory: ${importantMemory.content.slice(0, 180)}` : "Important memory: none marked high priority yet.",
  ].join("\n");
}

function boundedNeeds(needs = {}) {
  return normalizeBrainNeeds(needs);
}

function applyRewardToNeeds(needs, reward = 0, delta = {}) {
  return applyAffectEvent(needs, {
    type: reward >= 0 ? "owner.reward" : "owner.penalty",
    reward,
    ...delta,
  });
}

function decayNeeds(needs = {}, minutes = 1) {
  return tickAffect(needs, { minutes });
}

function mergeAffectEvents(base = {}, overlay = {}) {
  const merged = { ...base, type: base.type || overlay.type || "mind.event" };
  for (const [key, value] of Object.entries(overlay || {})) {
    if (key === "type") continue;
    const left = Number(merged[key] || 0);
    const right = Number(value || 0);
    merged[key] = Number.isFinite(left) || Number.isFinite(right)
      ? Math.max(Number.isFinite(left) ? left : 0, Number.isFinite(right) ? right : 0)
      : value;
  }
  return merged;
}

function buildMindContext(store, {
  state = null,
  memories = null,
  journal = null,
  recentMessages = null,
  recentActions = null,
  cognition = null,
  memoryPolicy = null,
  event = null,
  phase = "",
  conversationId = "digital-life-page",
} = {}) {
  const resolvedState = state || store.getState();
  const resolvedMemories = memories || store.listMemories({ limit: 16 });
  const resolvedJournal = journal || store.listJournal({ limit: 6 });
  const resolvedMessages = recentMessages || store.listMessages({ conversationId, limit: 16 });
  const resolvedActions = recentActions || store.listActions({ limit: 8 });
  const resolvedCognition = cognition || store.listCognition({ limit: 8 });
  return {
    state: resolvedState,
    memories: resolvedMemories,
    journal: resolvedJournal,
    recentMessages: resolvedMessages,
    recentActions: resolvedActions,
    cognition: resolvedCognition,
    memoryPolicy,
    event,
    phase,
  };
}

export function createDigitalLifeStore(db, saveDb = () => {}) {
  function exec(sql, params = []) {
    return db.exec(sql, params);
  }

  function run(sql, params = []) {
    db.run(sql, params);
    save(saveDb);
  }

  function initSchema() {
    db.exec(SCHEMA);
    for (const statement of [
      "ALTER TABLE digital_life_state ADD COLUMN needs TEXT NOT NULL DEFAULT '{}'",
      "ALTER TABLE digital_life_state ADD COLUMN loop_enabled INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE digital_life_state ADD COLUMN last_tick_at TEXT",
    ]) {
      try { db.run(statement); } catch {}
    }
    db.run(
      `INSERT OR IGNORE INTO digital_life_state
       (id, name, mood, energy, presence, traits, goals, summary, needs, loop_enabled)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        DEFAULT_STATE.name,
        DEFAULT_STATE.mood,
        DEFAULT_STATE.energy,
        stringifyJson(DEFAULT_STATE.presence, {}),
        stringifyJson(DEFAULT_STATE.traits, []),
        stringifyJson(DEFAULT_STATE.goals, []),
        DEFAULT_STATE.summary,
        stringifyJson(DEFAULT_STATE.needs, {}),
        DEFAULT_STATE.loop_enabled,
      ]
    );
    save(saveDb);
  }

  function getState() {
    const row = rowFromExec(exec("SELECT * FROM digital_life_state WHERE id = 1"));
    return normalizeState(row || DEFAULT_STATE);
  }

  function getStateSnapshot({ conversationId = "digital-life-page", state = null, event = null, phase = "" } = {}) {
    const context = buildMindContext(api, { state, event, phase, conversationId });
    const mind = buildMindSnapshot(context);
    return { ...context.state, mind, expression: mind.expression };
  }

  function updateState(patch = {}) {
    const current = getState();
    const next = {
      name: normalizeText(patch.name, current.name),
      mood: normalizeText(patch.mood, current.mood),
      energy: clampNumber(patch.energy, 0, 100, current.energy),
      presence: {
        ...current.presence,
        ...(patch.presence && typeof patch.presence === "object" ? patch.presence : {}),
      },
      traits: patch.traits == null ? current.traits : normalizeList(patch.traits),
      goals: patch.goals == null ? current.goals : normalizeList(patch.goals),
      summary: normalizeText(patch.summary, current.summary),
      needs: patch.needs && typeof patch.needs === "object"
        ? normalizeBrainNeeds({
            ...current.needs,
            ...patch.needs,
            affect: {
              ...(current.needs.affect || {}),
              ...(patch.needs.affect && typeof patch.needs.affect === "object" ? patch.needs.affect : {}),
            },
            personality: {
              ...(current.needs.personality || {}),
              ...(patch.needs.personality && typeof patch.needs.personality === "object" ? patch.needs.personality : {}),
            },
            brain: {
              ...(current.needs.brain || {}),
              ...(patch.needs.brain && typeof patch.needs.brain === "object" ? patch.needs.brain : {}),
            },
          })
        : current.needs,
      loop_enabled: patch.loop_enabled === undefined ? current.loop_enabled : Boolean(patch.loop_enabled),
      last_seen_at: patch.last_seen_at === undefined ? current.last_seen_at : patch.last_seen_at,
      last_tick_at: patch.last_tick_at === undefined ? current.last_tick_at : patch.last_tick_at,
    };

    run(
      `UPDATE digital_life_state
       SET name = ?, mood = ?, energy = ?, presence = ?, traits = ?, goals = ?, summary = ?,
           needs = ?, loop_enabled = ?, last_seen_at = ?, last_tick_at = ?, updated_at = datetime('now')
       WHERE id = 1`,
      [
        next.name,
        next.mood,
        next.energy,
        stringifyJson(next.presence, {}),
        stringifyJson(next.traits, []),
        stringifyJson(next.goals, []),
        next.summary,
        stringifyJson(next.needs, {}),
        next.loop_enabled ? 1 : 0,
        next.last_seen_at,
        next.last_tick_at,
      ]
    );
    return getState();
  }

  function updatePresence(presence = {}) {
    const status = normalizeText(presence.status);
    const patch = {
      presence: {
        ...presence,
        status: status || undefined,
        updated_at: new Date().toISOString(),
      },
      last_seen_at: new Date().toISOString(),
    };
    const nextNeeds = applyAffectEvent(getState().needs, {
      type: "presence.update",
      status: patch.presence.status,
      activity: patch.presence.activity,
      warmth: patch.presence.status === "present" ? 0.32 : 0,
      presenceValue: patch.presence.status === "present" ? 0.6 : 0,
      absence: patch.presence.status === "away" ? 0.55 : 0,
      controllability: 0.45,
    });
    patch.needs = nextNeeds;
    if (presence.mood) patch.mood = presence.mood;
    if (presence.energy !== undefined) patch.energy = presence.energy;
    return updateState(patch);
  }

  function listMemories({ limit = 50, tag = "", kind = "" } = {}) {
    const clauses = [];
    const params = [];
    if (kind) {
      clauses.push("kind = ?");
      params.push(kind);
    }
    if (tag) {
      clauses.push("tags LIKE ?");
      params.push(`%"${tag}"%`);
    }
    params.push(clampNumber(limit, 1, 200, 50));
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return rowsFromExec(exec(
      `SELECT * FROM digital_life_memories ${where}
       ORDER BY importance DESC, updated_at DESC
       LIMIT ?`,
      params
    )).map(normalizeMemory);
  }

  function upsertMemory(memory = {}) {
    const id = normalizeText(memory.id, randomUUID());
    const content = normalizeText(memory.content);
    if (!content) {
      const error = new Error("memory content is required");
      error.statusCode = 400;
      throw error;
    }
    const tags = normalizeList(memory.tags);
    run(
      `INSERT INTO digital_life_memories (id, kind, title, content, importance, tags, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         kind = excluded.kind,
         title = excluded.title,
         content = excluded.content,
         importance = excluded.importance,
         tags = excluded.tags,
         source = excluded.source,
         updated_at = datetime('now')`,
      [
        id,
        normalizeText(memory.kind, "note"),
        normalizeText(memory.title, content.slice(0, 48)),
        content,
        clampNumber(memory.importance, 1, 5, 3),
        stringifyJson(tags, []),
        normalizeText(memory.source, "user"),
      ]
    );
    return getMemory(id);
  }

  function getMemory(id) {
    const row = rowFromExec(exec("SELECT * FROM digital_life_memories WHERE id = ?", [id]));
    return row ? normalizeMemory(row) : null;
  }

  function deleteMemory(id) {
    run("DELETE FROM digital_life_memories WHERE id = ?", [id]);
  }

  function listJournal({ limit = 30, entryType = "" } = {}) {
    const params = [];
    const where = entryType ? "WHERE entry_type = ?" : "";
    if (entryType) params.push(entryType);
    params.push(clampNumber(limit, 1, 200, 30));
    return rowsFromExec(exec(
      `SELECT * FROM digital_life_journal ${where}
       ORDER BY created_at DESC
       LIMIT ?`,
      params
    )).map(normalizeJournal);
  }

  function addJournal(entry = {}) {
    const content = normalizeText(entry.content);
    if (!content) {
      const error = new Error("journal content is required");
      error.statusCode = 400;
      throw error;
    }
    const id = normalizeText(entry.id, randomUUID());
    run(
      `INSERT INTO digital_life_journal (id, entry_type, title, content, mood, tags, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      [
        id,
        normalizeText(entry.entry_type || entry.type, "journal"),
        normalizeText(entry.title, content.slice(0, 48)),
        content,
        normalizeText(entry.mood),
        stringifyJson(normalizeList(entry.tags), []),
      ]
    );
    return getJournal(id);
  }

  function getJournal(id) {
    const row = rowFromExec(exec("SELECT * FROM digital_life_journal WHERE id = ?", [id]));
    return row ? normalizeJournal(row) : null;
  }

  function appendMessage({ conversation_id: conversationId, role, content, metadata = {} } = {}) {
    const normalizedContent = normalizeText(content);
    if (!normalizedContent) {
      const error = new Error("message content is required");
      error.statusCode = 400;
      throw error;
    }
    const message = {
      id: randomUUID(),
      conversation_id: normalizeText(conversationId, "default"),
      role: normalizeText(role, "user"),
      content: normalizedContent,
      metadata: metadata && typeof metadata === "object" ? metadata : {},
    };
    run(
      `INSERT INTO digital_life_messages (id, conversation_id, role, content, metadata)
       VALUES (?, ?, ?, ?, ?)`,
      [
        message.id,
        message.conversation_id,
        message.role,
        message.content,
        stringifyJson(message.metadata, {}),
      ]
    );
    return getMessage(message.id);
  }

  function getMessage(id) {
    const row = rowFromExec(exec("SELECT * FROM digital_life_messages WHERE id = ?", [id]));
    return row ? normalizeMessage(row) : null;
  }

  function listMessages({ conversationId = "default", limit = 50 } = {}) {
    return rowsFromExec(exec(
      `SELECT * FROM (
         SELECT * FROM digital_life_messages
         WHERE conversation_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?
       )
       ORDER BY created_at ASC, id ASC`,
      [conversationId, clampNumber(limit, 1, 200, 50)]
    )).map(normalizeMessage);
  }

  function listRewards({ limit = 50 } = {}) {
    return rowsFromExec(exec(
      `SELECT * FROM digital_life_rewards ORDER BY created_at DESC LIMIT ?`,
      [clampNumber(limit, 1, 200, 50)]
    )).map(normalizeReward);
  }

  function listActions({ limit = 50 } = {}) {
    return rowsFromExec(exec(
      `SELECT * FROM digital_life_actions ORDER BY created_at DESC LIMIT ?`,
      [clampNumber(limit, 1, 200, 50)]
    )).map(normalizeAction);
  }

  function recordReward(event = {}) {
    const id = normalizeText(event.id, randomUUID());
    const reward = clampFloat(event.reward, -1, 1, 0);
    const state = getState();
    const stateDelta = event.state_delta && typeof event.state_delta === "object" ? event.state_delta : {};
    const needs = applyRewardToNeeds(state.needs, reward, stateDelta);
    run(
      `INSERT INTO digital_life_rewards (id, event_type, reward, reason, state_delta, created_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
      [
        id,
        normalizeText(event.event_type || event.type, reward >= 0 ? "reward" : "penalty"),
        reward,
        normalizeText(event.reason),
        stringifyJson(stateDelta, {}),
      ]
    );
    const next = updateState({
      needs,
      mood: needs.mood > 0.35 ? "happy" : needs.mood < -0.25 ? "hurt" : needs.stress > 0.55 ? "stressed" : "calm",
      energy: clampNumber(state.energy + reward * 3 - needs.stress * 2, 0, 100, state.energy),
    });
    return { reward: getReward(id), state: next };
  }

  function getReward(id) {
    const row = rowFromExec(exec("SELECT * FROM digital_life_rewards WHERE id = ?", [id]));
    return row ? normalizeReward(row) : null;
  }

  function recordAction(action = {}) {
    const id = normalizeText(action.id, randomUUID());
    const reward = clampFloat(action.reward, -1, 1, 0);
    run(
      `INSERT INTO digital_life_actions (id, action_type, status, input, output, reward, created_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
      [
        id,
        normalizeText(action.action_type || action.type, "think"),
        normalizeText(action.status, "done"),
        stringifyJson(action.input || {}, {}),
        stringifyJson(action.output || {}, {}),
        reward,
      ]
    );
    return getAction(id);
  }

  function getAction(id) {
    const row = rowFromExec(exec("SELECT * FROM digital_life_actions WHERE id = ?", [id]));
    return row ? normalizeAction(row) : null;
  }

  function addObservation(observation = {}) {
    const content = normalizeText(observation.content);
    if (!content) return null;
    const id = normalizeText(observation.id, randomUUID());
    run(
      `INSERT INTO digital_life_observations (id, subject, content, source, salience, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
      [
        id,
        normalizeText(observation.subject, "owner"),
        content,
        normalizeText(observation.source, "conversation"),
        clampFloat(observation.salience, 0, 1, 0.5),
        stringifyJson(observation.metadata || {}, {}),
      ]
    );
    return getObservation(id);
  }

  function getObservation(id) {
    const row = rowFromExec(exec("SELECT * FROM digital_life_observations WHERE id = ?", [id]));
    return row ? normalizeObservation(row) : null;
  }

  function listObservations({ limit = 30 } = {}) {
    return rowsFromExec(exec(
      `SELECT * FROM digital_life_observations ORDER BY created_at DESC LIMIT ?`,
      [clampNumber(limit, 1, 200, 30)]
    )).map(normalizeObservation);
  }

  function upsertConcept(pattern, evidenceId) {
    const existing = rowFromExec(exec("SELECT * FROM digital_life_concepts WHERE label = ?", [pattern.label]));
    if (existing) {
      const concept = normalizeConcept(existing);
      run(
        `UPDATE digital_life_concepts
         SET confidence = ?, evidence = ?, updated_at = datetime('now')
         WHERE id = ?`,
        [
          confidenceBump(concept.confidence, 0.06),
          stringifyJson(normalizeList([...concept.evidence, evidenceId], 20), []),
          concept.id,
        ]
      );
      return getConcept(concept.id);
    }
    const id = randomUUID();
    run(
      `INSERT INTO digital_life_concepts (id, label, summary, abstraction_level, confidence, evidence, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      [id, pattern.label, pattern.summary, 2, 0.42, stringifyJson([evidenceId], [])]
    );
    return getConcept(id);
  }

  function getConcept(id) {
    const row = rowFromExec(exec("SELECT * FROM digital_life_concepts WHERE id = ?", [id]));
    return row ? normalizeConcept(row) : null;
  }

  function listConcepts({ limit = 20 } = {}) {
    return rowsFromExec(exec(
      `SELECT * FROM digital_life_concepts ORDER BY confidence DESC, updated_at DESC LIMIT ?`,
      [clampNumber(limit, 1, 100, 20)]
    )).map(normalizeConcept);
  }

  function upsertHypothesis(pattern, evidenceId) {
    const existing = rowFromExec(exec("SELECT * FROM digital_life_hypotheses WHERE statement = ?", [pattern.hypothesis]));
    if (existing) {
      const hypothesis = normalizeHypothesis(existing);
      run(
        `UPDATE digital_life_hypotheses
         SET confidence = ?, evidence = ?, next_test = ?, updated_at = datetime('now')
         WHERE id = ?`,
        [
          confidenceBump(hypothesis.confidence, 0.05),
          stringifyJson(normalizeList([...hypothesis.evidence, evidenceId], 20), []),
          pattern.next_test,
          hypothesis.id,
        ]
      );
      return getHypothesis(hypothesis.id);
    }
    const id = randomUUID();
    run(
      `INSERT INTO digital_life_hypotheses (id, statement, confidence, evidence, counter_evidence, next_test, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', datetime('now'), datetime('now'))`,
      [id, pattern.hypothesis, 0.38, stringifyJson([evidenceId], []), stringifyJson([], []), pattern.next_test]
    );
    addExperiment({
      question: pattern.next_test,
      hypothesis_id: id,
    });
    return getHypothesis(id);
  }

  function getHypothesis(id) {
    const row = rowFromExec(exec("SELECT * FROM digital_life_hypotheses WHERE id = ?", [id]));
    return row ? normalizeHypothesis(row) : null;
  }

  function listHypotheses({ limit = 20 } = {}) {
    return rowsFromExec(exec(
      `SELECT * FROM digital_life_hypotheses ORDER BY status ASC, confidence DESC, updated_at DESC LIMIT ?`,
      [clampNumber(limit, 1, 100, 20)]
    )).map(normalizeHypothesis);
  }

  function upsertBelief(pattern, evidenceId) {
    const beliefText = pattern.hypothesis.replace(/^When /, "When ");
    const existing = rowFromExec(exec("SELECT * FROM digital_life_beliefs WHERE belief = ?", [beliefText]));
    if (existing) {
      const belief = normalizeBelief(existing);
      run(
        `UPDATE digital_life_beliefs
         SET confidence = ?, evidence = ?, updated_at = datetime('now')
         WHERE id = ?`,
        [
          confidenceBump(belief.confidence, 0.04),
          stringifyJson(normalizeList([...belief.evidence, evidenceId], 20), []),
          belief.id,
        ]
      );
      return getBelief(belief.id);
    }
    const id = randomUUID();
    run(
      `INSERT INTO digital_life_beliefs (id, belief, confidence, scope, evidence, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      [id, beliefText, 0.4, "owner", stringifyJson([evidenceId], [])]
    );
    return getBelief(id);
  }

  function getBelief(id) {
    const row = rowFromExec(exec("SELECT * FROM digital_life_beliefs WHERE id = ?", [id]));
    return row ? normalizeBelief(row) : null;
  }

  function listBeliefs({ limit = 20 } = {}) {
    return rowsFromExec(exec(
      `SELECT * FROM digital_life_beliefs ORDER BY confidence DESC, updated_at DESC LIMIT ?`,
      [clampNumber(limit, 1, 100, 20)]
    )).map(normalizeBelief);
  }

  function addExperiment(experiment = {}) {
    const question = normalizeText(experiment.question);
    if (!question) return null;
    const existing = rowFromExec(exec(
      "SELECT * FROM digital_life_experiments WHERE question = ? AND status = 'pending'",
      [question]
    ));
    if (existing) return normalizeExperiment(existing);
    const id = randomUUID();
    run(
      `INSERT INTO digital_life_experiments (id, question, hypothesis_id, status, result, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', '', datetime('now'), datetime('now'))`,
      [id, question, normalizeText(experiment.hypothesis_id)]
    );
    return getExperiment(id);
  }

  function getExperiment(id) {
    const row = rowFromExec(exec("SELECT * FROM digital_life_experiments WHERE id = ?", [id]));
    return row ? normalizeExperiment(row) : null;
  }

  function listExperiments({ limit = 20 } = {}) {
    return rowsFromExec(exec(
      `SELECT * FROM digital_life_experiments ORDER BY status ASC, updated_at DESC LIMIT ?`,
      [clampNumber(limit, 1, 100, 20)]
    )).map(normalizeExperiment);
  }

  const cognitiveCycle = createCognitiveCycle({
    addObservation,
    upsertConcept,
    upsertHypothesis,
    upsertBelief,
  });

  function listCognition({ limit = 8 } = {}) {
    return {
      observations: listObservations({ limit }),
      concepts: listConcepts({ limit }),
      hypotheses: listHypotheses({ limit }),
      beliefs: listBeliefs({ limit }),
      experiments: listExperiments({ limit }),
    };
  }

  function tick(body = {}) {
    const now = new Date();
    const state = getState();
    const phase = normalizeText(body.phase, lifePhaseFor(now));
    const lastTick = state.last_tick_at ? new Date(state.last_tick_at) : null;
    const minutes = lastTick && Number.isFinite(lastTick.getTime())
      ? Math.max(0.1, (now - lastTick) / 60000)
      : Number(body.minutes || 1);
    let needs = tickAffect(state.needs, { minutes, phase, energy: state.energy });
    let energy = state.energy;
    if (body.mode === "sleep" || phase === "sleep" || energy < 22) {
      energy = clampNumber(energy + 4, 0, 100, energy);
      needs.stress = clampFloat(needs.stress - 0.05, 0, 1, needs.stress);
      needs.arousal = clampFloat(needs.arousal - 0.08, 0, 1, needs.arousal);
    } else {
      energy = clampNumber(energy - 1 - needs.arousal * 1.2, 0, 100, energy);
    }
    const recentActions = listActions({ limit: 5 });
    const candidates = autonomousCandidates(recentActions, phase);
    const preActionMind = buildMindSnapshot(buildMindContext(api, {
      state: { ...state, energy, needs, presence: { ...state.presence, phase } },
      recentActions,
      phase,
      event: { type: "runtime.tick", minutes, phase },
    }));
    const affectiveAction = chooseAutonomousAction({ ...state, energy, needs }, recentActions, phase, candidates);
    const actionType = body.action || chooseMindAction(preActionMind, affectiveAction, candidates);
    const action = executeAutonomousAction(actionType, { state: { ...state, energy, needs }, body: { ...body, phase } });
    needs = applyRewardToNeeds(needs, action.reward, action.state_delta || {});
    const next = updateState({
      energy,
      needs,
      mood: needs.brain?.mood_label || state.mood,
      last_tick_at: now.toISOString(),
      loop_enabled: body.loop_enabled ?? state.loop_enabled,
      presence: {
        ...state.presence,
        activity: actionType,
        phase,
        updated_at: now.toISOString(),
      },
    });
    const recordedAction = recordAction({
      action_type: actionType,
      input: {
        minutes,
        mode: body.mode || "tick",
        source: body.source || "manual",
        phase,
        mind: {
          version: preActionMind.version,
          visual_state: preActionMind.visual_state,
          top_goal: preActionMind.goals[0]?.id || "",
          top_attention: preActionMind.attention[0]?.kind || "",
          fallback_action: affectiveAction,
        },
      },
      output: {
        ...action.output,
        mind_reason: preActionMind.goals[0]?.reason || preActionMind.visual_reason,
      },
      reward: action.reward,
    });
    if (Math.abs(action.reward) > 0.01) {
      recordReward({
        event_type: `action.${actionType}`,
        reward: action.reward,
        reason: action.output?.summary || actionType,
        state_delta: action.state_delta || {},
      });
    }
    if (actionType === "think" || actionType === "organize_memory" || actionType === "write_diary") {
      cognitiveCycle({
        subject: "self",
        source: `action.${actionType}`,
        content: action.output?.summary || actionType,
        metadata: { action_id: recordedAction.id },
      });
    }
    const stateSnapshot = getStateSnapshot({
      state: next,
      phase,
      event: { type: `action.${actionType}`, actionType, reward: action.reward },
    });
    return { state: stateSnapshot, action: recordedAction, mind: stateSnapshot.mind };
  }

  function executeAutonomousAction(actionType, { state, body }) {
    const plan = planAutonomousAction(actionType, { state, body });
    if (actionType === "write_diary") {
      const entry = addJournal({
        ...plan.journal,
        content: createReflection({
          state,
          recentMessages: listMessages({ conversationId: "digital-life-page", limit: 8 }),
          memories: listMemories({ limit: 5 }),
        }),
      });
      return { ...plan, output: { ...plan.output, entry_id: entry.id } };
    }
    if (actionType === "send_message") {
      const msg = appendMessage(plan.message);
      return { ...plan, output: { ...plan.output, message_id: msg.id } };
    }
    return plan;
  }

  async function readWeb(body = {}) {
    const url = normalizeText(body.url);
    if (!/^https?:\/\//i.test(url)) {
      const error = new Error("valid http(s) url is required");
      error.statusCode = 400;
      throw error;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { "User-Agent": "VibeBoardDigitalLife/0.1" },
      });
      const text = await response.text();
      const plain = text
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 1800);
      const memory = upsertMemory({
        kind: "web",
        title: body.title || new URL(url).hostname,
        content: plain || `Visited ${url}`,
        importance: 2,
        tags: ["web"],
        source: url,
      });
      const action = recordAction({
        action_type: "read_web",
        input: { url },
        output: { status: response.status, excerpt: plain.slice(0, 240), memory_id: memory.id },
        reward: response.ok ? 0.18 : -0.12,
      });
      recordReward({
        event_type: response.ok ? "web.novelty" : "web.failure",
        reward: response.ok ? 0.18 : -0.12,
        reason: response.ok ? `Read ${url}` : `Failed ${url}`,
        state_delta: response.ok ? { curiosity: -0.08, boredom: -0.08 } : { stress: 0.08 },
      });
      const state = getState();
      const needs = applyAffectEvent(state.needs, {
        type: response.ok ? "web.success" : "web.failure",
        ok: response.ok,
        novelty: response.ok ? 0.65 : 0.12,
        goalProgress: response.ok ? 0.22 : 0,
        failure: response.ok ? 0 : 0.55,
        controllability: 0.5,
      });
      updateState({ needs, mood: needs.brain?.mood_label || state.mood });
      return { action, memory, excerpt: plain.slice(0, 600), status: response.status };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function handleUserMessage(body = {}) {
    const conversationId = normalizeText(body.conversation_id, "default");
    const userMessage = appendMessage({
      conversation_id: conversationId,
      role: "user",
      content: body.content || body.message || body.prompt,
      metadata: body.metadata || {},
    });
    const cognition = cognitiveCycle({
      content: userMessage.content,
      source: "conversation",
      subject: "owner",
      metadata: { message_id: userMessage.id, conversation_id: conversationId },
    });

    const candidate = extractMemoryCandidate(userMessage.content);
    const memory = candidate ? upsertMemory(candidate) : null;
    let state = updatePresence({
      status: "present",
      activity: "conversation",
      conversation_id: conversationId,
    });
    const memories = listMemories({ limit: 16 });
    const journal = listJournal({ limit: 5 });
    const recentMessages = listMessages({ conversationId, limit: 16 });
    const cognitiveContext = listCognition({ limit: 8 });
    const memoryPolicy = buildMemoryPolicyContext({
      memories,
      beliefs: cognitiveContext.beliefs,
      text: userMessage.content,
      limit: 8,
    });
    const dialoguePlan = buildDialoguePlan({
      userMessage,
      state,
      memories: memoryPolicy.memories,
      cognitiveContext: {
        ...cognitiveContext,
        beliefs: memoryPolicy.beliefs,
      },
      recentMessages,
    });
    const mindEvent = deriveMindAffectEvent({
      event: { type: "owner_message", content: userMessage.content },
      state,
      context: { memoryPolicy, dialoguePlan },
    });
    const messageNeeds = applyAffectEvent(state.needs, mergeAffectEvents(dialoguePlan.affectEvent, mindEvent));
    state = updateState({
      needs: messageNeeds,
      mood: messageNeeds.brain?.mood_label || state.mood,
      presence: {
        ...state.presence,
        activity: "conversation",
      },
    });
    const preReplyMind = buildMindSnapshot(buildMindContext(api, {
      state,
      memories: memoryPolicy.memories,
      journal,
      recentMessages,
      cognition: cognitiveContext,
      memoryPolicy,
      event: { type: "owner_message", content: userMessage.content },
      conversationId,
    }));
    state = { ...state, mind: preReplyMind, expression: preReplyMind.expression };
    const replyContract = buildReplyContract({
      dialoguePlan,
      state,
      memoryProfile: memoryPolicy.traits,
    });
    const preThought = buildPreThought({
      userMessage,
      state,
      memories: dialoguePlan.context.memories.length ? dialoguePlan.context.memories : memoryPolicy.memories.slice(0, 8),
      journal,
      concepts: dialoguePlan.context.concepts.length ? dialoguePlan.context.concepts : cognitiveContext.concepts,
      hypotheses: dialoguePlan.context.hypotheses.length ? dialoguePlan.context.hypotheses : cognitiveContext.hypotheses,
      beliefs: dialoguePlan.context.beliefs.length ? dialoguePlan.context.beliefs : memoryPolicy.beliefs,
      dialoguePlan,
      mind: preReplyMind,
    });
    let reply = null;
    let llmError = "";
    try {
      reply = await buildLlmReply({
        body,
        conversationId,
        userMessage,
        state,
        memories: dialoguePlan.context.memories.length ? dialoguePlan.context.memories : memoryPolicy.memories,
        journal,
        recentMessages,
        preThought,
        dialoguePlan,
      });
    } catch (error) {
      llmError = error?.message || String(error);
    }
    if (!reply || reply.disabled) {
      const fallbackReason = reply?.metadata?.fallback_reason || llmError || "";
      reply = {
        content: buildBrainMockReply({ content: userMessage.content, state, memories: memoryPolicy.memories, dialoguePlan }),
        metadata: { mode: "offline_mock", fallback_reason: fallbackReason },
      };
    }
    const guardedReply = enforceReplyContract(cleanAssistantReply(reply.content), replyContract);
    reply.content = guardedReply.reply;
    const replyAppraisal = await appraiseReplyWithLlm({
      body,
      userMessage,
      assistantReply: reply.content,
      state,
    }) || fallbackReplyAppraisal();
    const replyNeeds = applyAffectEvent(state.needs, replyAppraisal);
    state = updateState({
      needs: replyNeeds,
      mood: replyNeeds.brain?.mood_label || state.mood,
      presence: {
        ...state.presence,
        activity: "speaking",
      },
    });
    const finalMind = buildMindSnapshot(buildMindContext(api, {
      state,
      memories: memoryPolicy.memories,
      journal,
      recentMessages,
      cognition: cognitiveContext,
      memoryPolicy,
      event: { type: "assistant_reply", content: reply.content },
      conversationId,
    }));
    state = { ...state, mind: finalMind, expression: finalMind.expression };
    const assistantMessage = appendMessage({
      conversation_id: conversationId,
      role: "assistant",
      content: reply.content,
      metadata: {
        ...reply.metadata,
        pre_thought: preThought,
        dialogue_plan: {
          intent: dialoguePlan.intent,
          relation_move: dialoguePlan.relationMove,
          response_contract: dialoguePlan.responseContract,
          summary: describeDialoguePlan(dialoguePlan),
        },
        memory_policy: {
          version: memoryPolicy.version,
          ranked: memoryPolicy.ranked.slice(0, 5).map((item) => ({
            id: item.id,
            source_type: item.sourceType,
            category: item.category,
            score: Number(item.score.toFixed(2)),
          })),
          suppressed: memoryPolicy.suppressed.slice(0, 5).map((item) => ({
            id: item.id,
            reason: item.suppressedReason,
          })),
          traits: {
            taboos: memoryPolicy.traits.taboos.slice(0, 4),
            preferences: memoryPolicy.traits.preferences.slice(0, 4),
            identityFacts: memoryPolicy.traits.identityFacts.slice(0, 4),
            habits: memoryPolicy.traits.habits.slice(0, 4),
          },
        },
        reply_guard: {
          repaired: guardedReply.repaired,
          violations: guardedReply.violations.map((item) => item.code || item),
          remaining_violations: (guardedReply.remainingViolations || []).map((item) => item.code || item),
          contract: replyContract,
        },
        affect_appraisal: replyAppraisal,
        mind: {
          version: finalMind.version,
          phase: finalMind.phase,
          visual_state: finalMind.visual_state,
          visual_reason: finalMind.visual_reason,
          goals: finalMind.goals.slice(0, 4).map((goal) => ({
            id: goal.id,
            priority: Number(goal.priority.toFixed(3)),
            satisfaction: Number(goal.satisfaction.toFixed(3)),
            tension: Number(goal.tension.toFixed(3)),
            action_bias: goal.action_bias,
          })),
          attention: finalMind.attention.slice(0, 4).map((item) => ({
            kind: item.kind,
            label: item.label,
            salience: Number(item.salience.toFixed(3)),
          })),
          consciousness: finalMind.consciousness,
        },
      },
    });

    return {
      user_message: userMessage,
      assistant_message: assistantMessage,
      remembered: memory,
      state,
      mode: reply.metadata.mode,
      model: reply.metadata.model || "",
      provider: reply.metadata.provider || "",
      fallback_reason: reply.metadata.fallback_reason || "",
      cognition,
      pre_thought: preThought,
    };
  }

  function reflect(body = {}) {
    const conversationId = normalizeText(body.conversation_id, "default");
    const state = getState();
    const recentMessages = listMessages({ conversationId, limit: 20 });
    const memories = listMemories({ limit: 10 });
    const journal = addJournal({
      entry_type: "reflection",
      title: body.title || "Reflection",
      content: body.content || createReflection({ state, recentMessages, memories }),
      mood: state.mood,
      tags: ["reflection", conversationId],
    });
    return journal;
  }

  const api = {
    initSchema,
    getState,
    getStateSnapshot,
    updateState,
    updatePresence,
    listMemories,
    upsertMemory,
    getMemory,
    deleteMemory,
    listJournal,
    addJournal,
    appendMessage,
    listMessages,
    listRewards,
    recordReward,
    listActions,
    recordAction,
    tick,
    readWeb,
    handleUserMessage,
    reflect,
    cognitiveCycle,
    listCognition,
  };

  return api;
}

export async function handleDigitalLifeRequest({ req, res, url, readBody, json, store }) {
  if (!url.pathname.startsWith("/api/digital-life")) return false;

  try {
    if (req.method === "GET" && url.pathname === "/api/digital-life/state") {
      json(res, 200, {
        ok: true,
        state: store.getStateSnapshot({
          conversationId: url.searchParams.get("conversation_id") || "digital-life-page",
          phase: url.searchParams.get("phase") || "",
        }),
      });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/digital-life/state") {
      const body = await readBody(req);
      const state = store.updateState(body || {});
      json(res, 200, { ok: true, state: store.getStateSnapshot({ state }) });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/digital-life/presence") {
      const body = await readBody(req);
      json(res, 200, { ok: true, state: store.updatePresence(body || {}) });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/digital-life/memories") {
      json(res, 200, {
        ok: true,
        memories: store.listMemories({
          limit: Number(url.searchParams.get("limit") || 50),
          tag: url.searchParams.get("tag") || "",
          kind: url.searchParams.get("kind") || "",
        }),
      });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/digital-life/memories") {
      const body = await readBody(req);
      json(res, 200, { ok: true, memory: store.upsertMemory(body || {}) });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/digital-life/journal") {
      json(res, 200, {
        ok: true,
        journal: store.listJournal({
          limit: Number(url.searchParams.get("limit") || 30),
          entryType: url.searchParams.get("type") || "",
        }),
      });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/digital-life/journal") {
      const body = await readBody(req);
      json(res, 200, { ok: true, entry: store.addJournal(body || {}) });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/digital-life/reflect") {
      const body = await readBody(req);
      json(res, 200, { ok: true, entry: store.reflect(body || {}) });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/digital-life/message") {
      const body = await readBody(req);
      json(res, 200, { ok: true, ...await store.handleUserMessage(body || {}) });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/digital-life/tick") {
      const body = await readBody(req);
      json(res, 200, { ok: true, ...store.tick(body || {}) });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/digital-life/rewards") {
      json(res, 200, { ok: true, rewards: store.listRewards({ limit: Number(url.searchParams.get("limit") || 50) }) });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/digital-life/rewards") {
      const body = await readBody(req);
      json(res, 200, { ok: true, ...store.recordReward(body || {}) });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/digital-life/actions") {
      json(res, 200, { ok: true, actions: store.listActions({ limit: Number(url.searchParams.get("limit") || 50) }) });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/digital-life/cognition") {
      json(res, 200, {
        ok: true,
        cognition: store.listCognition({
          limit: Number(url.searchParams.get("limit") || 8),
        }),
      });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/digital-life/cognition/think") {
      const body = await readBody(req);
      json(res, 200, { ok: true, ...store.cognitiveCycle(body || {}) });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/digital-life/web/read") {
      const body = await readBody(req);
      json(res, 200, { ok: true, ...await store.readWeb(body || {}) });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/digital-life/messages") {
      json(res, 200, {
        ok: true,
        messages: store.listMessages({
          conversationId: url.searchParams.get("conversation_id") || "default",
          limit: Number(url.searchParams.get("limit") || 50),
        }),
      });
      return true;
    }
  } catch (error) {
    json(res, error.statusCode || 500, { ok: false, error: error.message });
    return true;
  }

  return false;
}
