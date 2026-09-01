# Engineering Skills

This repo is configured for Codex engineering work using the local skill set installed from `mattpocock/skills` plus the existing VibeBoard architecture skill.

## Installed Skills

- `codebase-design`: Use for module boundaries, depth, seams, adapters, locality, and deletion-test reasoning.
- `domain-modeling`: Use when adding or refining project language in `CONTEXT.md` and durable decisions in `docs/adr/`.
- `grill-with-docs`: Use before large implementation work to interrogate existing docs and assumptions.
- `diagnosing-bugs`: Use when reproducing and narrowing runtime failures.
- `tdd`: Use when adding behavior behind tests before implementation.
- `triage`: Use for turning broad issue lists into ordered execution.
- `implement`: Use for scoped implementation work after design direction is clear.
- `to-issues`: Use for converting architecture opportunities into tracked tasks.
- `improve-codebase-architecture`: Use for scanning this repo for deeper module opportunities without jumping straight into rewrites.

Restart Codex after installing or updating skills so the new skill metadata is loaded.

## Repo Workflow

- Preserve the public `/api` behavior unless a task explicitly changes it.
- Treat `src/contracts.mjs` as the source of truth for generated-app hardware behavior.
- Keep companion/personality experiences as generated or market-deployable device apps, not platform-owned pages, routes, or background loops.
- Use `npm run check` for fast syntax and contract feedback.
- Use `npm run verify:agent` when changing generation, verification, build, route wiring, or hardware-contract behavior.
- Use `npm run verify:jobs` when changing task center, background job, idempotency, retry, or debug-recovery behavior.
- Keep the LangGraph v2 Agent workflow as the default `/api/agent` path. `VIBEBOARD_AGENT_WORKFLOW=v1` remains the rollback switch for direct server starts.
- LangGraph v2 graph changes must preserve `retrieve_context`, `contract_firewall`, and any `route_escalations` evidence. The model may write only `index.html`, `style.css`, and `app.js`; `hardware_app.py` and `manifest.json` are system-owned.

## Architecture Vocabulary

- A module is deep when it hides meaningful complexity behind a small API.
- A seam is real when two or more adapters can sit behind it without leaking implementation details.
- Locality matters: generated app behavior, board deployment, and platform chat code should remain independently understandable.
- Prefer extracting ownership boundaries from existing behavior before inventing new abstractions.
