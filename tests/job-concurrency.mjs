import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";

import initSqlJs from "sql.js";

import { createExecutionContext } from "../src/executionContext.mjs";
import {
  createFileProjectPersistence,
  createPostgresProjectPersistence,
  createSqliteProjectPersistence,
} from "../src/projectPersistence.mjs";
import { assert } from "./support/serverHarness.mjs";

const SQL = await initSqlJs();

await test("job creation is idempotent and organization scoped across persistence adapters", async () => {
  const filePath = fileURLToPath(new URL(`runtime/job-concurrency-${Date.now()}-${Math.random()}.json`, new URL("..", import.meta.url)));
  const adapters = [
    {
      name: "sqlite",
      create: () => createSqliteProjectPersistence({ sqliteDb: new SQL.Database(), saveSqlite: () => {} }),
    },
    {
      name: "postgres",
      create: () => createPostgresProjectPersistence({ pg: createMemoryPg() }),
    },
    {
      name: "json",
      create: () => createFileProjectPersistence({ filePath }),
    },
  ];

  try {
    for (const adapter of adapters) {
      const persistence = adapter.create();
      await persistence.initSchema();
      await assertIdempotencyContract(persistence, adapter.name);
    }
  } finally {
    await fs.rm(filePath, { force: true });
  }
});

async function assertIdempotencyContract(persistence, adapterName) {
  const organizationA = contextFor("org-a", "project-a");
  const organizationB = contextFor("org-b", "project-b");
  const shared = {
    prompt: "Build a status dashboard",
    apiKey: "secret-a",
    api_secret: "secret-b",
    secretKey: "secret-c",
    access_key: "secret-d",
    auth_token: "secret-e",
    cookie: "secret-f",
    session: "secret-g",
    database_url: "postgres://should-not-persist",
    openai_api_key: "compound-secret-h",
    connection_string: "compound-secret-i",
    ssh_password: "compound-secret-j",
    request_id: "transient-a",
  };

  const first = await persistence.createOrGetJob({
    context: organizationA,
    operation: "generate",
    idempotencyKey: "duplicate-key",
    input: shared,
  });
  const duplicate = await persistence.createOrGetJob({
    context: organizationA,
    operation: "generate",
    idempotencyKey: "duplicate-key",
    input: { request_id: "transient-b", prompt: "Build a status dashboard", apiKey: "secret-b" },
  });

  assert(first.id === duplicate.id, `${adapterName}: a duplicate operation/key must return its original job`);
  assert(first.organization_id === "org-a", `${adapterName}: jobs should expose organization identity`);
  assert(first.project_id === "project-a", `${adapterName}: jobs should expose project identity`);
  assert(first.idempotency_key === "duplicate-key", `${adapterName}: jobs should expose their idempotency key`);
  assert(first.input_digest, `${adapterName}: jobs should retain a normalized input digest`);
  assert(first.input.apiKey === undefined, `${adapterName}: raw api keys must not be returned from job input`);
  assert(first.input.api_secret === undefined, `${adapterName}: api secrets must not be returned from job input`);
  assert(first.input.secretKey === undefined, `${adapterName}: secret keys must not be returned from job input`);
  assert(first.input.access_key === undefined, `${adapterName}: access keys must not be returned from job input`);
  assert(first.input.auth_token === undefined, `${adapterName}: auth tokens must not be returned from job input`);
  assert(first.input.cookie === undefined, `${adapterName}: cookies must not be returned from job input`);
  assert(first.input.session === undefined, `${adapterName}: sessions must not be returned from job input`);
  assert(first.input.database_url === undefined, `${adapterName}: database URLs must not be returned from job input`);
  assert(first.input.openai_api_key === undefined, `${adapterName}: compound API key fields must not be returned from job input`);
  assert(first.input.connection_string === undefined, `${adapterName}: connection strings must not be returned from job input`);
  assert(first.input.ssh_password === undefined, `${adapterName}: compound password fields must not be returned from job input`);
  assert(first.input.accessToken === undefined, `${adapterName}: raw access tokens must not be returned from job input`);
  assert(first.input.password === undefined, `${adapterName}: raw passwords must not be returned from job input`);

  let conflict = null;
  try {
    await persistence.createOrGetJob({
      context: organizationA,
      operation: "generate",
      idempotencyKey: "duplicate-key",
      input: { prompt: "Build a different dashboard" },
    });
  } catch (error) {
    conflict = error;
  }
  assert(conflict?.errorType === "idempotency_conflict", `${adapterName}: the same key with a changed prompt should be rejected`);

  const volatileFirst = await persistence.createOrGetJob({
    context: organizationA,
    operation: "generate",
    idempotencyKey: "volatile-key",
    input: { prompt: "Build with stable input", request_id: "request-a", clientRunId: "client-a" },
  });
  const volatileDuplicate = await persistence.createOrGetJob({
    context: organizationA,
    operation: "generate",
    idempotencyKey: "volatile-key",
    input: { prompt: "Build with stable input", requestId: "request-b", client_run_id: "client-b" },
  });
  assert(volatileFirst.id === volatileDuplicate.id, `${adapterName}: exact volatile key variants must not change the digest`);

  await persistence.createOrGetJob({
    context: organizationA,
    operation: "generate",
    idempotencyKey: "max-tokens-key",
    input: { prompt: "Bounded generation", max_tokens: 128 },
  });
  let maxTokensConflict = null;
  try {
    await persistence.createOrGetJob({
      context: organizationA,
      operation: "generate",
      idempotencyKey: "max-tokens-key",
      input: { prompt: "Bounded generation", max_tokens: 256 },
    });
  } catch (error) {
    maxTokensConflict = error;
  }
  assert(maxTokensConflict?.errorType === "idempotency_conflict", `${adapterName}: max_tokens must remain digest-significant`);

  const otherOrganizationJob = await persistence.createOrGetJob({
    context: organizationB,
    operation: "generate",
    idempotencyKey: "duplicate-key",
    input: shared,
  });
  assert(otherOrganizationJob.id !== first.id, `${adapterName}: organizations must not share idempotency keys`);
  assert(await persistence.getJobForOrganization(otherOrganizationJob.id, "org-a") === null, `${adapterName}: one organization cannot load another organization's job`);
  assert(await persistence.requestCancelForOrganization(otherOrganizationJob.id, "org-a") === null, `${adapterName}: one organization cannot cancel another organization's job`);
  assert((await persistence.getJobForOrganization(otherOrganizationJob.id, "org-b"))?.status === "queued", `${adapterName}: cross-organization cancellation must not mutate the target`);
  const canceled = await persistence.requestCancelForOrganization(otherOrganizationJob.id, "org-b");
  assert(canceled?.status === "canceled", `${adapterName}: the owning organization can cancel its job`);

  const claimable = await persistence.createOrGetJob({
    context: organizationA,
    operation: "generate",
    idempotencyKey: "claim-key",
    input: { prompt: "Claim this job once" },
  });
  const claimed = await persistence.claimJob(claimable.id);
  assert(claimed?.status === "running", `${adapterName}: queued jobs should be claimed atomically`);
  assert(await persistence.claimJob(claimable.id) === null, `${adapterName}: a running job must not be claimed twice`);

  const firstKey = await persistence.createOrGetJob({
    context: organizationA,
    operation: "generate",
    idempotencyKey: "key-one",
    input: { prompt: "Build one" },
  });
  const secondKey = await persistence.createOrGetJob({
    context: organizationA,
    operation: "generate",
    idempotencyKey: "key-two",
    input: { prompt: "Build two" },
  });
  assert(firstKey.id !== secondKey.id, `${adapterName}: distinct keys must create distinct jobs`);
  assert(firstKey.status === "queued" && secondKey.status === "queued", `${adapterName}: distinct-key jobs must be queued`);
}

function contextFor(organizationId, projectId) {
  return createExecutionContext({
    organizationId,
    actorId: `${organizationId}-actor`,
    projectId,
    operation: "generate",
    requestId: `${organizationId}-request`,
  });
}

function createMemoryPg() {
  const jobs = [];
  const pg = async (strings, ...values) => {
    const text = strings.join("?");
    if (/INSERT INTO jobs/.test(text)) {
      const [id, type, status, phase, conversationId, title, organizationId, projectId, buildId, idempotencyKey, inputDigest, inputJson, outputJson, errorJson, choicesJson, logsJson, cancelRequested, createdAt, updatedAt, startedAt, completedAt] = values;
      const existing = jobs.find(job => job.organization_id === organizationId && job.type === type && job.idempotency_key === idempotencyKey && idempotencyKey);
      if (existing) return [];
      const row = {
        id,
        type,
        status,
        phase,
        conversation_id: conversationId,
        title,
        organization_id: organizationId,
        project_id: projectId,
        build_id: buildId,
        idempotency_key: idempotencyKey,
        input_digest: inputDigest,
        input_json: inputJson,
        output_json: outputJson,
        error_json: errorJson,
        choices_json: choicesJson,
        logs_json: logsJson,
        cancel_requested: cancelRequested,
        created_at: createdAt,
        updated_at: updatedAt,
        started_at: startedAt,
        completed_at: completedAt,
      };
      jobs.push(row);
      return [row];
    }
    if (/UPDATE jobs/.test(text) && /WHERE organization_id/.test(text)) {
      const [status, phase, errorJson, choicesJson, cancelRequested, updatedAt, completedAt, organizationId, id] = values;
      const job = jobs.find(item => item.organization_id === organizationId && item.id === id);
      if (job) {
        Object.assign(job, {
          status,
          phase,
          error_json: errorJson,
          choices_json: choicesJson,
          cancel_requested: cancelRequested,
          updated_at: updatedAt,
          completed_at: completedAt,
        });
      }
      return [];
    }
    if (/UPDATE jobs/.test(text) && /RETURNING \*/.test(text)) {
      const [status, phase, updatedAt, startedAt, id, queuedStatus, cancelRequested] = values;
      const job = jobs.find(item => item.id === id && item.status === queuedStatus && Number(item.cancel_requested || 0) === Number(cancelRequested));
      if (!job) return [];
      Object.assign(job, { status, phase, updated_at: updatedAt, started_at: job.started_at || startedAt });
      return [job];
    }
    if (/SELECT \* FROM jobs WHERE id/.test(text)) return jobs.filter(job => job.id === values[0]);
    if (/SELECT \* FROM jobs\s+WHERE organization_id/.test(text)) {
      const [organizationId, type, idempotencyKey] = values;
      if (type && idempotencyKey) return jobs.filter(job => job.organization_id === organizationId && job.type === type && job.idempotency_key === idempotencyKey);
      return jobs.filter(job => job.organization_id === organizationId && job.id === values[1]);
    }
    if (/SELECT \* FROM jobs/.test(text)) return jobs;
    return [];
  };
  return pg;
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}
