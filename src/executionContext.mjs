import { randomUUID } from "node:crypto";

const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/;

export function createExecutionContext(input = {}) {
  const organizationId = requiredId(input.organizationId ?? input.organization_id, "organization");
  const actorId = requiredId(input.actorId ?? input.actor_id, "actor");
  const projectId = requiredId(input.projectId ?? input.project_id, "project");
  const operation = requiredId(input.operation, "operation");
  const requestId = optionalId(input.requestId ?? input.request_id, "request") || randomUUID();

  return Object.freeze({
    organizationId,
    actorId,
    projectId,
    applicationId: optionalId(input.applicationId ?? input.application_id, "application"),
    buildId: optionalId(input.buildId ?? input.build_id, "build"),
    deviceId: optionalId(input.deviceId ?? input.device_id, "device"),
    conversationId: optionalId(input.conversationId ?? input.conversation_id, "conversation"),
    operation,
    requestId,
    idempotencyKey: normalizeIdempotencyKey(input),
  });
}

export function normalizeIdempotencyKey(input = {}) {
  for (const value of [input.client_run_id, input.clientRunId, input.request_id]) {
    const key = optionalId(value, "idempotency");
    if (key) return key;
  }
  return "";
}

export function executionContextFromRequest(req = {}, user = null, body = {}) {
  const input = body && typeof body === "object" ? body : {};
  const actorId = requiredId(user?.id, "actor");
  const conversationId = optionalId(input.conversationId ?? input.conversation_id, "conversation");
  const requestId = optionalId(
    input.requestId ?? input.request_id ?? req?.headers?.["x-request-id"] ?? normalizeIdempotencyKey(input),
    "request"
  );

  return createExecutionContext({
    organizationId: user?.organizationId ?? user?.organization_id ?? `personal:${actorId}`,
    actorId,
    projectId: input.projectId ?? input.project_id ?? conversationId ?? `personal-project:${actorId}`,
    applicationId: input.applicationId ?? input.application_id,
    buildId: input.buildId ?? input.build_id,
    deviceId: input.deviceId ?? input.device_id,
    conversationId,
    operation: input.operation ?? input.type ?? "generate",
    requestId,
    client_run_id: input.client_run_id,
    clientRunId: input.clientRunId,
    request_id: input.request_id,
  });
}

function requiredId(value, field) {
  const normalized = optionalId(value, field);
  if (!normalized) throw invalidContext(`${field} identity is required.`);
  return normalized;
}

function optionalId(value, field) {
  if (value === undefined || value === null) return "";
  const normalized = String(value).trim();
  if (!normalized) return "";
  if (CONTROL_CHARACTERS.test(normalized)) {
    throw invalidContext(`${field} identity cannot contain control characters.`);
  }
  return normalized;
}

function invalidContext(message) {
  const error = new Error(message);
  error.errorType = "execution_context_invalid";
  return error;
}
