# DeepSeek Agent Physical Companion Acceptance

Date: 2026-07-20

## Verdict

The generic VibeBoard Agent improvements and deterministic acceptance harness pass locally. The final paid DeepSeek V4 Pro run did not pass acceptance: the planner/build request timed out before returning generated files. No real-board deployment was attempted or claimed.

## Scope

- Synthetic Digital Life physical-companion simulator only.
- Existing VibeBoard DeepSeek tool-calling Agent, confirmation gate, generation runtime, and L0-L3 verification.
- 480x360 transparent-screen target with KEY1, KEY2, and KEY3 behavior.
- No L4 real-board verification.

## Baseline

Two pre-improvement paid runs were retained as redacted timing evidence:

| Run | Duration | Result |
| --- | ---: | --- |
| 1 | about 262 s | Agent work occurred, but the benchmark runner failed during progress cleanup |
| 2 | about 281.5 s | Outer request timeout; no accepted artifact |

Both exceeded the 180 s acceptance budget. Generated file bodies, provider responses, credentials, and raw reasoning were not persisted.

## Improvements Implemented

- Added a bounded `agent-task-contract.v1` passed through confirmation into generation.
- Added deterministic context compaction that preserves assistant/tool pairs.
- Added a revision-aware duplicate-action guard and recovery feedback.
- Added public telemetry containing only counts, durations, completion reason, and safe codes.
- Added truthful model, tool, verification, recovery, and terminal progress events in the existing task UI.
- Added batching guidance for independent tool calls, including creating all new-project files in one model response.
- Enforced the configured total Agent execution budget inside `runAgent`; it was previously logged but unused.
- Added standard L0-L3 plus scenario-specific static and Playwright acceptance gates.

## Deterministic Verification

| Gate | Result |
| --- | --- |
| Syntax check | PASS, 92 files |
| Agent regression | PASS, 113 passed / 0 failed |
| Agent loop quality | PASS |
| Auth and persistence | PASS |
| Offline flow | PASS |
| Existing Digital Life suite | PASS |
| Platform UI smoke | PASS |
| Benchmark contract negative controls | PASS |
| Fixture benchmark | PASS, 100/100, zero hard-gate failures |

The fixture acceptance includes:

- all 14 expression states and all 3 skins;
- local `memory-projection.v1` retrieval behavior and `expression-state.v1` transitions;
- KEY1 expression, KEY2 memory overlay, and KEY3 skin transitions in Chromium;
- `DigitalLifeDeviceSimulator.getState()` inspection;
- existing VibeBoard L0-L3 contract, syntax, hardware simulation, and render verification;
- 480x360 and 390x844 screenshots with no measured overflow;
- nonblank render samples, zero page errors, and zero external requests.

Screenshots:

- `runtime/benchmarks/screenshots/fixture-digital-life-physical-companion-480x360.png`
- `runtime/benchmarks/screenshots/fixture-digital-life-physical-companion-390x844.png`

## Final DeepSeek Run

| Metric | Result | Required |
| --- | ---: | ---: |
| Accepted | No | Yes |
| Duration | 288,263 ms | at most 180,000 ms |
| Score | 0 | at least 90 |
| Model turns | unavailable | at most 14 |
| Generated files | unavailable | 5 required files |
| Terminal success event | missing | exactly one |

The failure type is `timeout`. Because no build result was returned, semantic, browser, and L0-L3 checks could not run on live-generated files. This is not treated as a model-quality pass.

## Failure Analysis And Correction

The platform configured `timeoutMs=120000`, but `runAgent` did not consume that value. A high-latency multi-turn run could therefore continue until the benchmark's 240 s outer request timeout. The system prompt also encouraged extra preparatory turns and did not explicitly ask the model to batch independent file tools.

The local correction now:

- applies one total Agent deadline across all model turns;
- clamps each model-call timeout to the remaining Agent budget;
- returns explicit timeout telemetry and one failed terminal progress event;
- skips an unnecessary learning lookup for a clean new project;
- asks capable providers to issue independent file tools together.

A deterministic delayed-provider regression proves the internal deadline. No fourth paid run was made, so the latency correction is locally verified but not live-confirmed against DeepSeek.

## Security And Deployment Evidence

- The API key was supplied only to the isolated benchmark child process.
- Secret-value scanning found no real credential in source or benchmark artifacts.
- Artifacts omit prompts, messages, generated file bodies, authorization fields, provider responses, and raw reasoning.
- Temporary databases and generated directories were removed after each live attempt.
- No hardware deploy endpoint or SSH deployment action was invoked.
- Verification remains L0-L3 only; L4 requires a later explicit real-board run.

## Remaining Blocker

One gated DeepSeek rerun is required to prove that batching plus the enforced internal deadline produces a complete accepted simulator within 180 seconds. Until that run passes, the platform improvement is locally validated but the requested live DeepSeek acceptance remains incomplete.

## Extended-Wait Follow-up

After the owner explicitly approved waiting beyond the original performance budget, the benchmark was changed to preserve the original 180-second score while allowing a 30-minute execution window.

The follow-up established:

- Node's built-in `fetch` control request terminated near 300 seconds even with a longer AbortSignal. Replacing the loopback control request with `http.request` removed that hidden connection limit.
- A 14-turn DeepSeek run completed in 476,863 ms and scored 60. It generated a recognizable companion face with all 14 expression labels, three skins, memory projection data, and key declarations, but failed focused behavior and local readability checks.
- A 30-turn DeepSeek run completed in 426,883 ms and also scored 60. More turns did not improve convergence; the model continued rewriting and introduced an external-dependency violation.
- The Agent now validates complete files even when the model-turn limit is reached, instead of treating file presence as success.
- Incomplete `create_file` and `edit_file` arguments now become recoverable tool results instead of uncaught TypeErrors.
- A targeted repair pass was added so scenario and L0-L3 failure codes can be applied to the existing generated files rather than starting over.
- The next online attempt was rejected immediately with HTTP 402 (`llm_failed`). This is an external billing/quota condition, so the targeted repair pass could not be live-verified.

The latest usable live screenshot is:

- `runtime/benchmarks/screenshots/live-digital-life-physical-companion-480x360.png`

Current conclusion: DeepSeek connectivity and real tool-driven generation are proven. Unlimited waiting is not sufficient by itself; the remaining work is blocked by provider billing/quota, and the last successful long runs demonstrate a convergence problem rather than a timeout-only problem.
