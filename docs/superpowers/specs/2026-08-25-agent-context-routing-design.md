# Agent Context Routing and Retrieval Design

## Status

Approved for implementation on 2026-08-25.

## Problem

VibeBoard currently treats most model-backed builds as the same full Agent
workflow. The only meaningful generation split is model-enabled versus
template fallback. This makes small changes pay the cost of planning,
multiple tool turns, automatic verification, and possible repair loops. It
also makes the system rely on model instructions for hardware safety.

Project memory, user preferences, build experiences, playbooks, and asset
metadata are already stored, but each source is assembled independently.
Assets are classified by deterministic extension rules and then collapsed
into four UI folders. The Agent receives broad summaries rather than
relevance-ranked context.

## Goals

1. Route work by risk and execution profile rather than a brittle
   simple/complex boolean.
2. Let a task start cheaply and promote itself when execution reveals new
   dependencies or risk.
3. Make hardware contracts system-owned and read-only to the code Agent.
4. Add a portable, deterministic asset relevance index without requiring an
   external vector service.
5. Provide one memory retrieval interface with provenance, scope, ranking,
   and tenant boundaries.
6. Preserve existing public API shapes and old generated projects.
7. Keep all local L0-L3 verification and deployment confirmation gates.

## Non-goals

- Do not introduce a hosted vector database in this iteration.
- Do not rewrite existing user asset files or historical build snapshots.
- Do not remove the existing hardware wrapper immediately; use it as a
  compatibility adapter during migration.
- Do not let route scoring bypass syntax, render, hardware simulation, or
  snapshot verification.
- Do not make model-generated code responsible for real-device deployment.

## Architecture

### 1. Execution profiles

`src/taskRoutePolicy.mjs` will expose pure functions:

```js
scoreTaskRoute({ prompt, projectFiles, projectMemory, assets, action })
classifyTaskRoute(scoreResult)
routeToExecutionProfile(route, scoreResult)
```

The result is a serializable profile:

```js
{
  schema_version: "task-route.v1",
  route: "fast_patch" | "guided_build" | "full_agent" | "clarify_or_block",
  score: 0,
  confidence: 0,
  reasons: [],
  hard_gates: [],
  max_model_turns: 4,
  max_verification_attempts: 1,
  repair_attempts: 0,
  requires_confirmation: true
}
```

Hard gates are evaluated before thresholds. Hardware, deployment, SSH,
permissions, external APIs, databases, authentication, persistence, and
destructive operations cannot use `fast_patch`. Ambiguous or contradictory
requirements route to `clarify_or_block`.

The first implementation uses transparent weighted rules. A request with
conflicting signals is promoted to the safer profile. During execution,
discovered hardware/API/multi-file dependencies promote the profile; a
profile is never downgraded after a risk gate is observed.

Fast profiles still run all required local verification. They only reduce
planning, tool, and repair budgets.

### 2. Hardware contract firewall

The hardware contract becomes a versioned system-owned artifact. The Agent
may propose hardware capabilities in structured metadata, but it cannot
create or edit the canonical `hardware_app.py` contract implementation.

The server will:

1. Limit Agent writes to frontend files and safe manifest metadata.
2. Generate or adapt `hardware_app.py` after the Agent run.
3. Validate contract version, required runtime APIs, build id, stdout JSON,
   and allowed files before a build is publishable.
4. Remove direct real-device deployment from the normal generation tool path.
5. Require a server-side confirmation, bound device, contract hash, and
   deployable-file allowlist at deployment time.

Existing projects use the current wrapper/injector as a compatibility path.
The system may add missing contract fields, but the model cannot rewrite the
hardware business logic through `edit_file` or `create_file`.

### 3. Asset relevance index

Keep `asset_library` as the source of asset bytes and public metadata. Add
derived tables:

```text
asset_relevance_docs
  asset_id, conversation_id, kind, category, role, usage,
  normalized_text, summary_hash, updated_at

asset_relevance_terms
  conversation_id, asset_id, term, facet, weight
```

`kind` remains the technical file type. `category` is the user-facing
folder category. `role` describes reference-only, embeddable, functional, or
archived use. Low-confidence items remain available as `unclassified`
instead of being forced into `other`.

The index is rebuilt on add/update/delete and lazily backfilled for old rows.
Search is scoped to the current organization/project/conversation and ranks
exact name matches, prompt terms, summary facets, explicit selection,
recent use, and prior successful build use. `promptContext` consumes the top
relevant assets instead of the entire asset list. Existing assets and public
asset endpoints remain compatible.

The first version uses an application-level inverted term table because it is
portable across the current sql.js and PostgreSQL-backed persistence paths.
FTS5 or embeddings can be added later behind the same interface.

### 4. Unified memory retrieval

Add a `loadMemoryContext` boundary that receives organization, actor,
project, conversation, query, mode, and limit. It returns entries with
`source`, `scope`, `content`, `confidence`, `updated_at`, and `provenance`.

Ranking precedence is:

```text
confirmed project facts
> recent direct conversation
> project file and asset summaries
> user preferences
> project build experience
> product-wide playbooks
```

`project_memory` is the structured source of truth. `MEMORY.md` is a derived
human-readable snapshot and is not independently authoritative. Global
preferences and product-wide playbooks are explicitly marked as global;
project and user memory queries are scoped by organization/project/actor.

The retrieval layer returns only relevant bounded entries to the planner and
generator. It does not put every historical message or every asset into the
prompt.

## Failure handling

- If route classification cannot determine a safe profile, use
  `clarify_or_block` and present one actionable choice question.
- If a fast task discovers a hard gate, persist the route escalation and
  restart with the guided/full profile using the same build snapshot.
- If a hardware contract check fails, show the exact contract field and keep
  the build available for repair; never attempt deployment.
- If an asset index is unavailable, fall back to the existing deterministic
  asset summary and log degraded retrieval.
- If memory retrieval is unavailable, use project memory only and mark the
  context as degraded; never cross project or organization boundaries.

## Verification criteria

1. Pure route tests cover boundary scores, hard gates, ambiguity, and
   promotion.
2. A single-file style task uses the fast profile while still passing L0-L3.
3. Calendar, asset-heavy, API, microphone, and deployment tasks use the
   appropriate guided/full profile.
4. Agent writes to `hardware_app.py` are rejected, while system injection and
   legacy wrapper compatibility remain green.
5. Asset search returns stable relevant ordering, preserves explicit assets,
   and does not classify low-confidence files as a false type.
6. Memory retrieval returns provenance and never leaks another project or
   tenant's data.
7. Existing persistence, UI, job, and hardware contract tests remain green.
8. Telemetry records route, score, escalation, model turns, verification
   attempts, and retrieval degradation.

