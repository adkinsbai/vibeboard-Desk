import assert from "node:assert/strict";
import {
  createExecutionContext,
  executionContextFromRequest,
  normalizeIdempotencyKey,
} from "../src/executionContext.mjs";

const equivalent = createExecutionContext({
  organizationId: " org-a ",
  actorId: " user-a ",
  projectId: " project-a ",
  operation: " generate ",
  requestId: " req-a ",
});
const canonical = createExecutionContext({
  organizationId: "org-a",
  actorId: "user-a",
  projectId: "project-a",
  operation: "generate",
  requestId: "req-a",
});

assert.deepEqual(equivalent, canonical, "equivalent inputs normalize to the same context");
assert.equal(equivalent.organizationId, "org-a", "context keeps organization identity");
assert(Object.isFrozen(equivalent), "context is immutable");
assert.throws(
  () => {
    equivalent.actorId = "user-b";
  },
  TypeError,
  "frozen contexts cannot be mutated"
);
assert.throws(
  () => createExecutionContext({ actorId: "user-a", projectId: "project-a", operation: "generate" }),
  error => error?.errorType === "execution_context_invalid" && /organization/i.test(error.message),
  "non-migrated contexts require an organization"
);
assert.throws(
  () => createExecutionContext({ organizationId: "org-a", projectId: "project-a", operation: "generate" }),
  error => error?.errorType === "execution_context_invalid" && /actor/i.test(error.message),
  "contexts require an actor"
);
assert.throws(
  () => createExecutionContext({ organizationId: "org-a", actorId: "user-a", operation: "generate" }),
  error => error?.errorType === "execution_context_invalid" && /project/i.test(error.message),
  "contexts require a project"
);
assert.throws(
  () => createExecutionContext({ organizationId: "org-a\u0000", actorId: "user-a", projectId: "project-a", operation: "generate" }),
  error => error?.errorType === "execution_context_invalid" && /control/i.test(error.message),
  "contexts reject control characters"
);
assert.throws(
  () => createExecutionContext({ organizationId: "org-a\u0085", actorId: "user-a", projectId: "project-a", operation: "generate" }),
  error => error?.errorType === "execution_context_invalid" && /control/i.test(error.message),
  "contexts reject C1 control characters"
);

assert.equal(
  normalizeIdempotencyKey({ client_run_id: " client-run ", clientRunId: "camel", request_id: "legacy" }),
  "client-run",
  "client_run_id takes precedence over legacy keys"
);
assert.equal(
  normalizeIdempotencyKey({ clientRunId: " camel ", request_id: "legacy" }),
  "camel",
  "clientRunId is the first legacy fallback"
);
assert.equal(
  normalizeIdempotencyKey({ client_run_id: " ", clientRunId: " camel ", request_id: "legacy" }),
  "camel",
  "empty preferred keys fall through to the next supported key"
);
assert.equal(
  normalizeIdempotencyKey({ request_id: " legacy " }),
  "legacy",
  "request_id is the final legacy fallback"
);

const requestContext = executionContextFromRequest({}, { id: " user-a " }, {
  conversation_id: " conversation-a ",
  client_run_id: " client-run-a ",
  application_id: " app-a ",
  build_id: " build-a ",
  device_id: " device-a ",
});
assert.deepEqual(requestContext, {
  organizationId: "personal:user-a",
  actorId: "user-a",
  projectId: "conversation-a",
  applicationId: "app-a",
  buildId: "build-a",
  deviceId: "device-a",
  conversationId: "conversation-a",
  operation: "generate",
  requestId: "client-run-a",
  idempotencyKey: "client-run-a",
}, "request contexts preserve explicit IDs and derive legacy personal ownership");

const fallbackProjectContext = executionContextFromRequest({}, { id: "user-b" }, {
  operation: "agent",
});
assert.equal(
  fallbackProjectContext.projectId,
  "personal-project:user-b",
  "request contexts fall back to a personal project when project and conversation IDs are absent"
);

console.log(JSON.stringify({ ok: true }));
