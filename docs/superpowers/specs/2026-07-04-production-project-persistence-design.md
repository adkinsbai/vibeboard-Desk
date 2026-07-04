# Production Project Persistence Design

## Goal

Make public Vercel generation durable under multi-instance and concurrent usage by moving production project state out of the whole-database SQLite snapshot bridge and into first-class Postgres tables, while preserving the local-first SQLite workflow for Windows and board prototypes.

## Context

The public Vercel deployment currently uses Postgres directly for auth, credits, and telemetry, but stores conversations, generated files, project memory, jobs, and asset metadata in a sql.js SQLite database. On Vercel, that SQLite database is exported as one base64 blob in the `sqlite_snapshots` table.

Live verification on July 4, 2026 reproduced a production failure:

- `/api/health` returned healthy with `publicDeployment=true` and `db=postgres`.
- Registration and conversation creation succeeded.
- `/api/jobs` completed generation with `status=succeeded`.
- Remote render verification passed and returned screenshot evidence.
- The follow-up `GET /api/conversations/{id}/files` returned `404 Conversation not found`.

This proves the generation and runner can succeed while the public project state later disappears. The most likely root cause is lost updates between Vercel instances: each instance loads and saves a whole SQLite snapshot, so an older in-memory snapshot can overwrite newer conversation/file/job rows.

## Design Decision

Introduce a deep module named `ProjectPersistence`.

The module interface owns the public project state needed by generation, preview restoration, conversation history, and job tracking. Callers should not know whether persistence is backed by local SQLite or production Postgres.

Production uses a Postgres adapter. Local development and board prototypes keep using a SQLite adapter.

This preserves ADR 0003's local-first runtime database for local and prototype usage, but removes the SQLite snapshot bridge from the production write path.

## Interface

`ProjectPersistence` should provide a small interface around these behaviours:

- `initSchema()`
- `listConversations({ userId })`
- `createConversation({ id, title, userId, projectDir })`
- `getConversation(id)`
- `updateConversation(id, patch)`
- `deleteConversation(id)`
- `appendMessage(conversationId, message)`
- `listMessages(conversationId)`
- `saveConversationFiles(conversationId, buildId, files)`
- `loadConversationFiles(conversationId)`
- `deleteConversationFiles(conversationId)`
- `getProjectMemory(conversationId)`
- `setProjectMemory(conversationId, memory)`
- `createJob(input)`
- `getJob(id)`
- `listJobs(filters)`
- `transitionJob(id, patch)`
- `appendJobLog(id, message, data, phase)`
- `requestCancelJob(id)`

The exact signatures can be refined during implementation, but the seam must support the current `conversationStore` and `jobStore` call sites without leaking adapter details.

## Production Tables

The Postgres adapter should create and use these tables:

- `conversations`
- `messages`
- `conversation_files`
- `project_memory`
- `jobs`

Rows should keep the existing field names and JSON shapes where possible so current routes, UI code, and tests remain stable. Generated file content can remain text for the existing snapshot file set. Binary asset handling should stay with the current asset library path unless implementation shows it is required for preview restoration.

Recommended constraints:

- `conversations.id` is primary key.
- `messages.conversation_id` references `conversations.id` with cascade delete.
- `conversation_files.conversation_id` references `conversations.id` with cascade delete.
- `project_memory.conversation_id` references `conversations.id` with cascade delete.
- `jobs.id` is primary key.
- Index `conversations(user_id, updated_at)`.
- Index `messages(conversation_id, created_at)`.
- Index `conversation_files(conversation_id, id)`.
- Index `jobs(conversation_id, created_at)`.
- Index `jobs(status, created_at)`.

## Atomicity

Generation jobs may only return `succeeded` after:

1. Generated files exist.
2. L0-L3 and runner verification passed according to the current generation path.
3. Conversation files were saved durably for the relevant conversation.
4. The final job state was saved durably.

If saving generated files or final job state fails, the user-visible job must fail with a storage-oriented error. The system must not report a successful generation that cannot be restored after refresh, conversation switch, or preview reload.

## Migration

Do not clear production data.

The migration should be compatible and staged:

1. Create the Postgres project persistence tables if they do not exist.
2. Keep `sqlite_snapshots` intact as a read-only migration source.
3. On startup or first relevant read, load the legacy snapshot only for migration.
4. Copy legacy conversations, messages, conversation files, project memory, and jobs into Postgres using idempotent upserts.
5. After migration, production reads and writes use Postgres tables.
6. Keep the legacy snapshot table available until live verification shows stable project restore behaviour.

The implementation may start with lazy migration because it avoids a separate operations step. If lazy migration is used, it must be idempotent and must not overwrite newer Postgres rows with older snapshot rows.

## Server Wiring

`server.mjs` remains the composition root.

Expected wiring:

- In local mode, create the SQLite-backed adapter from the existing stores.
- In public Vercel mode, create the Postgres-backed adapter when `DATABASE_URL` is available.
- Stop calling `syncDbFromSnapshot()` for production project-state API reads.
- Keep auth, credits, and telemetry on their existing Postgres paths.
- Keep the SQLite snapshot bridge only for local tests or legacy migration, not as the production write path.

## Error Handling

Storage failures should be classified as `storage_failed`.

User-facing result:

- The job should be marked `failed`.
- The response should explain that project data could not be saved and the user should retry.
- The technical detail should preserve the underlying database error without exposing secrets.

The current behaviour where snapshot save failures are logged but generation still succeeds must end for production project persistence.

## Common User Flows That Must Be Stable

- Register, create a project, generate an app, refresh, and still see generated files.
- Register, create a project, generate an app, switch conversations, switch back, and still see preview and code files.
- Generate through `/api/generate` with `background: true` in public deployment.
- Generate through `/api/jobs` with `type=generate`.
- Load Task Center after generation and see the final job.
- Run two Vercel-style server instances against the same persistence layer without losing either instance's writes.

## Testing

Add tests before implementation.

Required regression coverage:

- A Postgres-compatible adapter test using a fake or file-backed test adapter that simulates two independent server instances sharing one durable store.
- A test that reproduces the lost-update shape: instance A creates a conversation and files, instance B writes another job or conversation, and both writes survive.
- A request-bound public generation test where successful job output is followed by successful `/api/conversations/{id}/files`.
- A storage failure test where `saveConversationFiles` fails and the generation job is not marked `succeeded`.
- Existing auth, public generation, offline smoke, and job store tests continue to pass.

Preferred commands:

- `npm run check`
- `npm run verify:auth`
- `npm run verify:agent`
- `npm run verify:offline`
- `npm run verify:public`

## Deployment Verification

After implementation and deployment:

1. `vercel inspect https://vibeboard-chi.vercel.app` reports Ready.
2. `npm run verify:public` passes against the production alias.
3. A manual or scripted second run confirms that generated files still load after refresh.
4. Vercel logs show no `Conversation not found` after successful generation for newly created conversations.

## Out Of Scope

- Moving auth, credits, or telemetry; they already use Postgres paths.
- Exposing public hardware deployment to regular users.
- Reworking the UI beyond clearer storage-failure messaging if needed.
- Replacing the local SQLite database for Windows or RK3566 prototype workflows.
- Introducing a separate worker service.

