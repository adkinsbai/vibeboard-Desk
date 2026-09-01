# Architecture Opportunities

This scan tracks active VibeBoard platform opportunities. Companion/personality experiences should remain generated or market-deployable device apps, not platform-owned pages, routes, stores, or background loops.

## 1. Move Route Dispatch Out of `server.mjs`

Files: `server.mjs`, `src/generateRuntime.mjs`, `src/buildRuntime.mjs`, `src/agentOrchestrator.mjs`

Problem: `server.mjs` still owns static serving, board APIs, status APIs, audio APIs, model settings, chat, clarify, preferences, experiences, playbooks, agent routes, generation, builds, deployment, conversations, market routes, and preview assets. Route ordering and dependency wiring are difficult to reason about.

Solution direction: Keep `server.mjs` as the composition root and move route families into focused route modules.

Benefits: Route changes become more local, tests can mount route families independently, and generation or deployment work is less likely to disturb unrelated APIs.

## 2. Create a Shared Server Test Harness

Files: `tests/verify-agent.mjs`, `tests/offline-smoke.mjs`, `tests/production-persistence.mjs`, `tests/support/serverHarness.mjs`

Problem: Smoke tests still duplicate some server spawning, readiness checks, temp database setup, fetch helpers, and assertion patterns.

Solution direction: Continue consolidating spawned-server helpers, isolated database paths, JSON requests, fixture generation, and common assertions in the shared harness.

Benefits: Tests stay consistent, regressions become cheaper to add, and runtime isolation rules are harder to forget.

## 3. Deepen Generated-App Verification Around the Hardware Contract

Files: `src/contracts.mjs`, `src/verifiers/index.mjs`, `src/buildRuntime.mjs`, `src/generateRuntime.mjs`, `server.mjs`, `tests/verify-agent.mjs`

Problem: The hardware contract is centralized, but evidence assembly, failure classification, syntax checks, render checks, and build responses still cross several modules.

Solution direction: Give generated-app verification its own module boundary that consumes the central contract and returns normalized evidence and errors.

Benefits: Hardware rules remain exact, build/generate code becomes simpler, and verification failures become easier to display and test.

## 4. Clean Up Runtime Artifact Hygiene

Files: `.gitignore`, root screenshots/logs/database files, `runtime/`, `generated/`, `previews/`

Problem: The repo root contains many generated screenshots, logs, and runtime artifacts. This makes code review and architecture scanning noisy, and local database state can become confused with source state.

Solution direction: Classify generated artifacts, runtime databases, screenshots, and durable fixtures, then tighten ignore rules carefully without deleting existing user files.

Benefits: Smaller diffs, clearer scans, lower risk of leaking local runtime state, and safer database recovery.

## Suggested Order

1. Shared server test harness.
2. Route dispatch split.
3. Verification boundary.
4. Artifact hygiene.
