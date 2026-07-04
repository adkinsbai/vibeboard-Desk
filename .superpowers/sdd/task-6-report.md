### Task 6 Report: Legacy Snapshot Migration and Documentation

Status: DONE

Implemented:
- Added legacy SQLite snapshot reader and best-effort migration into ProjectPersistence-backed file/Postgres stores.
- Migration imports missing conversations, messages, generated files, project memory, and jobs without overwriting existing target rows.
- Wired public server startup migration after `projectPersistence.initSchema()` with warning-only error handling.
- Updated public Vercel deployment docs to describe first-class Postgres project-state storage and `sqlite_snapshots` as legacy migration source only.

TDD Evidence:
- RED: `npm run verify:persistence` failed after adding the brief migration test with `TypeError: target.migrateLegacySqliteSnapshot is not a function`.
- RED: added all-legacy-jobs coverage; `npm run verify:persistence` failed with `migration should import jobs beyond the first listing page`.
- GREEN: `npm run verify:persistence` passed.

Verification:
- `npm run verify:persistence` passed.
- `node tests/production-persistence.mjs` passed.
- `npm run check` passed with syntax check passed for 82 files.

Concerns:
- None.

Review Fixes:
- Added same-key target coverage so stale legacy conversation metadata, messages, files, project memory, and jobs cannot overwrite current target state.
- Added repeated/concurrent migration coverage for file-backed child rows and Postgres conflict-safe child import coverage.
- Changed migration to import legacy messages/files by stable legacy row keys, merge files without replacing same-filename current files, make file-backed job import idempotent, and avoid metadata updates when importing children into an existing conversation.

Review Fix TDD Evidence:
- RED: `npm run verify:persistence` failed with concurrent file-backed migration JSON corruption before the idempotence guard.
- RED: `npm run verify:persistence` failed with `missing legacy message should be imported by stable key` and `importing children should not reorder existing conversation`.
- RED: strengthened same-filename file coverage failed with `current same-key file should not be overwritten`.
- GREEN: `npm run verify:persistence` passed with 14 project-persistence tests.

Review Fix Verification:
- `npm run verify:persistence` passed.
- `node tests/production-persistence.mjs` passed.
- `npm run check` passed with syntax check passed for 82 files.

Re-Review Fix:
- Added Postgres legacy project-memory import coverage for an existing conversation with missing target memory; RED `npm run verify:persistence` failed with `legacy memory import must not update conversations.updated_at`.
- Added migration-only `importLegacyProjectMemory()` for Postgres using `INSERT ... ON CONFLICT DO NOTHING`, so legacy memory rows import without calling normal `setProjectMemory()` or updating parent conversation ordering timestamps.

Re-Review Fix Verification:
- `npm run verify:persistence` passed with 15 project-persistence tests.
- `npm run check` passed with syntax check passed for 82 files.
- `node tests/production-persistence.mjs` passed.

Remaining Task 6 Review Fix:
- Added `shouldSaveSqliteSnapshot()` so public production without `VIBEBOARD_TEST_CLOUD_SQLITE_FILE` keeps `sqlite_snapshots` read-only for legacy migration and no longer writes snapshots from `saveDb()`.
- Kept local/test snapshot compatibility for `VIBEBOARD_TEST_CLOUD_SQLITE_FILE`.
- Added production-persistence regression coverage for the guarded save path.

Remaining Task 6 Verification:
- RED: `node tests/production-persistence.mjs` failed with `server should disable legacy sqlite_snapshots writes in public production without VIBEBOARD_TEST_CLOUD_SQLITE_FILE`.
- GREEN: `node tests/production-persistence.mjs` passed.
- `npm run check` passed with syntax check passed for 82 files.
- `npm run verify:persistence` passed with 15 project-persistence tests.
