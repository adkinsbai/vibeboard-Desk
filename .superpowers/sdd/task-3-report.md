# Task 3 Report: Add Postgres ProjectPersistence Adapter

## Status

DONE_WITH_CONCERNS

## Files Changed

- `src/projectPersistence.mjs`
- `tests/project-persistence.mjs`

## TDD Evidence

### Schema RED

Command:

```powershell
npm run verify:persistence
```

Output snippet:

```text
ok - sqlite ProjectPersistence preserves conversations, files, memory, and jobs
ok - file ProjectPersistence keeps writes from two independent instances
ok - file ProjectPersistence does not overwrite newer rows with stale writers
not ok - postgres ProjectPersistence initializes first-class project tables
Error: Postgres ProjectPersistence is not implemented yet.
```

### Schema GREEN

Command:

```powershell
npm run verify:persistence
```

Output snippet:

```text
ok - sqlite ProjectPersistence preserves conversations, files, memory, and jobs
ok - file ProjectPersistence keeps writes from two independent instances
ok - file ProjectPersistence does not overwrite newer rows with stale writers
ok - postgres ProjectPersistence initializes first-class project tables
```

### Row-Level Write RED

Command:

```powershell
npm run verify:persistence
```

Output snippet:

```text
ok - postgres ProjectPersistence initializes first-class project tables
not ok - postgres ProjectPersistence issues row-level writes instead of sqlite snapshot writes
TypeError: persistence.createConversation is not a function
```

### Row-Level Write GREEN

Command:

```powershell
npm run verify:persistence
```

Output snippet:

```text
ok - sqlite ProjectPersistence preserves conversations, files, memory, and jobs
ok - file ProjectPersistence keeps writes from two independent instances
ok - file ProjectPersistence does not overwrite newer rows with stale writers
ok - postgres ProjectPersistence initializes first-class project tables
ok - postgres ProjectPersistence issues row-level writes instead of sqlite snapshot writes
```

## Final Verification

Command:

```powershell
npm run verify:persistence
```

Output snippet:

```text
ok - postgres ProjectPersistence initializes first-class project tables
ok - postgres ProjectPersistence issues row-level writes instead of sqlite snapshot writes
```

Command:

```powershell
npm run check
```

Output snippet:

```text
ok src\projectPersistence.mjs
ok tests\project-persistence.mjs
syntax check passed (82 files)
```

## Implementation Notes

- Added `createPostgresProjectPersistence({ pg })` using the Neon tagged-template delegate.
- Added first-class Postgres tables for conversations, messages, conversation_files, project_memory, and jobs.
- Added row-level SQL methods matching the SQLite adapter surface.
- Preserved Task 1/2 SQLite and file-backed adapter behavior.
- Did not wire `server.mjs`, touch production env, migrate data, or write `sqlite_snapshots`.
- Used a fake `pg` delegate in tests only; no real database calls were made.

## Concerns

- DONE_WITH_CONCERNS because Task 3 intentionally verifies SQL shape and adapter calls with a fake `pg`; real Neon/Postgres execution and transaction behavior remain for future integration wiring.
- Some multi-step writes are not wrapped in explicit Postgres transactions yet, matching the current task scope and fake-delegate test boundary.

## Commit

871c314 feat: add postgres project persistence

## Review Fixes

### Findings Fixed

- Stored absent Postgres `started_at` and `completed_at` TIMESTAMPTZ values as `null` while preserving the public job shape as `""` on returned jobs.
- Made Postgres `saveConversationFiles()` replace rows through `pg.transaction(tx => [...])` when transaction support exists, with sequential fallback for fake delegates.
- Matched SQLite read-side resilience by filtering Postgres `loadConversationFiles()` rows before deserializing and returning files.

### Review RED

Command:

```powershell
npm run verify:persistence
```

Output snippet:

```text
not ok - postgres ProjectPersistence sends null for absent job timestamp columns
Error: queued job should insert null started_at
not ok - postgres ProjectPersistence replaces conversation files in a transaction when supported
Error: file replacement should use pg.transaction
not ok - postgres ProjectPersistence filters loaded conversation files
Error: undeclared file rows should be filtered
```

### Review GREEN

Command:

```powershell
npm run verify:persistence
```

Output snippet:

```text
ok - postgres ProjectPersistence sends null for absent job timestamp columns
ok - postgres ProjectPersistence replaces conversation files in a transaction when supported
ok - postgres ProjectPersistence filters loaded conversation files
```

Command:

```powershell
npm run check
```

Output snippet:

```text
ok src\projectPersistence.mjs
ok tests\project-persistence.mjs
syntax check passed (82 files)
```
