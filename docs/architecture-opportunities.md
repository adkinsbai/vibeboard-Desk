# Architecture Opportunities

This scan looked for places where the codebase has low locality, mixed ownership, or missing seams. The goal is to identify candidates for deeper modules, not to prescribe interfaces yet.

## 1. Deepen the Digital Life Companion Runtime

Files: `src/digitalLife.mjs`, `tests/digital-life-smoke.mjs`, `digital-life.js`

Problem: `src/digitalLife.mjs` combines schema setup, persistence, memory handling, cognition patterns, prompt construction, LLM calls, autonomous actions, web reading, message handling, and route handling in one large module. That makes cognition changes hard to test without exercising the full HTTP/runtime path.

Solution direction: Split the companion runtime by ownership: store, cognition cycle, dialogue/prethought, autonomous actions, and HTTP route adapter.

Benefits: Companion behavior can evolve without route churn, cognition can be tested directly, and the standalone page keeps the same API surface.

## 2. Make Speech and Presence Real Hardware Adapters

Files: `src/digitalLifeHardware.mjs`, `server.mjs`, `digital-life.js`

Problem: Environment parsing, XFYUN online TTS, long-text TTS, command playback, microphone/listen placeholders, and presence simulation are mixed together. Provider failure modes and UI-facing route shapes are coupled.

Solution direction: Introduce speech and presence adapter boundaries with provider-specific implementations behind them.

Benefits: XFYUN, local TTS, command playback, and future ASR can be swapped or tested without changing companion dialogue logic.

## 3. Move Route Dispatch Out of `server.mjs`

Files: `server.mjs`, `src/generateRuntime.mjs`, `src/buildRuntime.mjs`, `src/digitalLife.mjs`, `src/agentOrchestrator.mjs`

Problem: `server.mjs` is still responsible for static serving, board APIs, status APIs, audio APIs, model settings, chat, clarify, preferences, experiences, playbooks, agent routes, generation, builds, deployment, conversations, market routes, and preview assets. Route ordering and dependency wiring are difficult to reason about.

Solution direction: Keep `server.mjs` as the composition root and move route families into focused route modules.

Benefits: Route changes become more local, tests can mount route families independently, and generation or companion work is less likely to disturb unrelated APIs.

## 4. Create a Shared Server Test Harness

Files: `tests/verify-agent.mjs`, `tests/digital-life-smoke.mjs`, `tests/offline-smoke.mjs`

Problem: Smoke tests duplicate server spawning, readiness checks, temp database setup, fetch helpers, and assertion patterns. `tests/verify-agent.mjs` is large enough that adding regressions increases friction.

Solution direction: Extract a test harness for spawned servers, isolated database paths, JSON requests, fixture generation, and common assertions.

Benefits: Tests stay consistent, Digital Life and agent regressions become cheaper to add, and runtime isolation rules are harder to forget.

## 5. Deepen Generated-App Verification Around the Hardware Contract

Files: `src/contracts.mjs`, `src/verifiers/index.mjs`, `src/buildRuntime.mjs`, `src/generateRuntime.mjs`, `server.mjs`, `tests/verify-agent.mjs`

Problem: The hardware contract is centralized, but evidence assembly, failure classification, syntax checks, render checks, and build responses still cross several modules.

Solution direction: Give generated-app verification its own module boundary that consumes the central contract and returns normalized evidence and errors.

Benefits: Hardware rules remain exact, build/generate code becomes simpler, and verification failures become easier to display and test.

## 6. Separate Digital Life UI State From DOM Rendering

Files: `digital-life.html`, `digital-life.css`, `digital-life.js`

Problem: The browser file mixes polling, optimistic messages, message rendering, audio playback, waveform analysis, runtime state, settings forms, and controls. This has already shown visible UX regressions around pending messages and chat positioning.

Solution direction: Keep the no-framework frontend, but split the file into clear local ownership areas or small modules for API client, message state, audio driver, and renderers.

Benefits: Frontend behavior can be verified with smaller Playwright checks, and changes to speech visualization do not risk message ordering.

## 7. Clean Up Runtime Artifact Hygiene

Files: `.gitignore`, root screenshots/logs/database files, `runtime/`, `generated/`, `previews/`

Problem: The repo root contains many generated screenshots, logs, and runtime artifacts. This makes code review and architecture scanning noisy, and local database state can become confused with source state.

Solution direction: Classify generated artifacts, runtime databases, screenshots, and durable fixtures, then tighten ignore rules carefully without deleting existing user files.

Benefits: Smaller diffs, clearer scans, lower risk of leaking local runtime state, and safer database recovery.

## Suggested Order

1. Shared server test harness.
2. Digital Life runtime split.
3. Speech and presence adapter boundary.
4. Route dispatch split.
5. Verification boundary.
6. Digital Life UI state split.
7. Artifact hygiene.
