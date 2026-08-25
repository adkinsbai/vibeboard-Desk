import { strict as assert } from "node:assert";
import test from "node:test";

import { createContextRetriever } from "../src/contextRetriever.mjs";

const baseInput = {
  organizationId: "org-a",
  actorId: "user-a",
  projectId: "project-a",
  conversationId: "conv-a",
  query: "launch screen blue theme",
  mode: "build",
  limit: 6,
};

await test("loadMemoryContext ranks scoped project facts ahead of recent messages and preserves provenance", async () => {
  const retriever = createContextRetriever({
    projectMemory: async ({ projectId }) => (projectId === "project-a" ? [
      {
        source: "projectMemory",
        scope: { organizationId: "org-a", projectId: "project-a", conversationId: "conv-a" },
        content: "Project A uses a blue launch screen.",
        confidence: 0.99,
        updated_at: "2026-08-25T01:00:00.000Z",
        provenance: { id: "pm-a" },
      },
    ] : [
      {
        source: "projectMemory",
        scope: { organizationId: "org-a", projectId: "project-b", conversationId: "conv-b" },
        content: "Project B uses a red launch screen.",
        confidence: 0.99,
        updated_at: "2026-08-25T01:00:00.000Z",
        provenance: { id: "pm-b" },
      },
    ]),
    recentMessages: async () => ([
      {
        source: "recentMessages",
        scope: { organizationId: "org-a", projectId: "project-a", conversationId: "conv-a" },
        content: "Let's keep the launch screen blue.",
        confidence: 0.7,
        updated_at: "2026-08-25T02:00:00.000Z",
        provenance: { id: "msg-a" },
      },
      {
        source: "recentMessages",
        scope: { organizationId: "org-a", projectId: "project-b", conversationId: "conv-b" },
        content: "Project B wants a red launch screen.",
        confidence: 0.7,
        updated_at: "2026-08-25T02:00:00.000Z",
        provenance: { id: "msg-b" },
      },
    ]),
    fileSummaries: async () => [],
    assetSummaries: async () => [],
    preferences: async () => [],
    experiences: async () => [],
    playbooks: async () => [],
  });

  const result = await retriever.loadMemoryContext(baseInput);

  assert.equal(result.degraded, false, "healthy providers should not degrade");
  assert.equal(result.entries.length, 2, "only scoped project entries should be returned");
  assert.equal(result.entries[0].source, "projectMemory", "project facts should outrank recent messages");
  assert.equal(result.entries[0].scope.projectId, "project-a", "project A entries should be retained");
  assert.equal(result.entries[0].content, "Project A uses a blue launch screen.");
  assert.equal(result.entries[1].source, "recentMessages", "recent messages should come after project facts");
  assert(result.entries.every((entry) => entry.provenance && entry.provenance.id), "provenance should be preserved");
});

await test("loadMemoryContext filters other projects, ranks query-relevant lower layers, and applies the limit stably", async () => {
  const retriever = createContextRetriever({
    projectMemory: async () => [],
    recentMessages: async () => [],
    fileSummaries: async () => ([
      {
        source: "fileSummaries",
        scope: { organizationId: "org-a", projectId: "project-a" },
        content: "File summary mentions a launch screen and onboarding copy.",
        confidence: 0.55,
        updated_at: "2026-08-25T03:00:00.000Z",
        provenance: { id: "file-1" },
      },
      {
        source: "fileSummaries",
        scope: { organizationId: "org-a", projectId: "project-b" },
        content: "File summary mentions the launch screen for project B.",
        confidence: 0.55,
        updated_at: "2026-08-25T03:00:00.000Z",
        provenance: { id: "file-b" },
      },
    ]),
    assetSummaries: async () => ([
      {
        source: "assetSummaries",
        scope: { organizationId: "org-a", projectId: "project-a" },
        content: "Asset summary mentions blue iconography.",
        confidence: 0.5,
        updated_at: "2026-08-25T03:10:00.000Z",
        provenance: { id: "asset-1" },
      },
      {
        source: "assetSummaries",
        scope: { organizationId: "org-a", projectId: "project-a" },
        content: "Asset summary mentions launch screen banner art.",
        confidence: 0.5,
        updated_at: "2026-08-25T03:11:00.000Z",
        provenance: { id: "asset-2" },
      },
    ]),
    preferences: async () => ([
      {
        source: "preferences",
        scope: { organizationId: "org-a", actorId: "user-a", global: true },
        content: "Prefer a blue theme.",
        confidence: 0.4,
        updated_at: "2026-08-25T04:00:00.000Z",
        provenance: { id: "pref-1" },
      },
    ]),
    experiences: async () => ([
      {
        source: "experiences",
        scope: { organizationId: "org-a", projectId: "project-a" },
        content: "Previous experience: blue launch screen worked best.",
        confidence: 0.35,
        updated_at: "2026-08-25T05:00:00.000Z",
        provenance: { id: "exp-1" },
      },
    ]),
    playbooks: async () => ([
      {
        source: "playbooks",
        scope: { global: true },
        content: "General launch screen checklist.",
        confidence: 0.3,
        updated_at: "2026-08-25T06:00:00.000Z",
        provenance: { id: "pb-1" },
      },
      {
        source: "playbooks",
        scope: { global: true },
        content: "Red screen guidance.",
        confidence: 0.3,
        updated_at: "2026-08-25T06:00:00.000Z",
        provenance: { id: "pb-2" },
      },
    ]),
  });

  const result = await retriever.loadMemoryContext({
    ...baseInput,
    limit: 5,
  });

  assert.equal(result.entries.length, 5, "result count should respect the limit");
  assert.equal(result.entries[0].source, "fileSummaries", "query-relevant file summaries should outrank lower layers after project facts/messages");
  assert.equal(result.entries[1].source, "assetSummaries", "asset summaries should rank with the same tier as file summaries");
  assert.equal(result.entries[2].source, "assetSummaries", "asset summaries should stay ahead of preferences when the tier is fuller");
  assert.equal(result.entries[3].source, "preferences", "preferences should outrank experiences and playbooks");
  assert.equal(result.entries[4].source, "experiences", "experiences should outrank playbooks");
  assert(result.entries.every((entry) => entry.scope.projectId !== "project-b"), "other project entries must be filtered out");
});

await test("loadMemoryContext degrades when a provider throws and formatMemoryContext surfaces the state", async () => {
  const retriever = createContextRetriever({
    projectMemory: async () => {
      throw new Error("project memory unavailable");
    },
    recentMessages: async () => ([
      {
        source: "recentMessages",
        scope: { organizationId: "org-a", projectId: "project-a", conversationId: "conv-a" },
        content: "Fallback message stays available.",
        confidence: 0.6,
        updated_at: "2026-08-25T07:00:00.000Z",
        provenance: { id: "msg-fallback" },
      },
    ]),
    fileSummaries: async () => [],
    assetSummaries: async () => [],
    preferences: async () => [],
    experiences: async () => [],
    playbooks: async () => [],
  });

  const result = await retriever.loadMemoryContext({
    ...baseInput,
    query: "fallback",
  });

  assert.equal(result.degraded, true, "provider failures should mark the result degraded");
  assert(result.availableLayers.includes("recentMessages"), "surviving layers should be reported");
  assert(!result.availableLayers.includes("projectMemory"), "failed layers should not be marked available");
  assert.equal(result.entries.length, 1, "surviving entries should still be returned");

  const formatted = retriever.formatMemoryContext(result);
  assert(formatted.includes("degraded"), "formatted output should mention degraded retrieval");
  assert(formatted.includes("recentMessages"), "formatted output should include the surviving source");
});

console.log(JSON.stringify({ ok: true }, null, 2));
