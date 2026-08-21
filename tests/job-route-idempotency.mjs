import { assert, withServer } from "./support/serverHarness.mjs";

await withServer(async ({ baseUrl }) => {
  const register = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: "+15559876543", password: "route-idempotency-42" }),
  });
  assert(register.ok, `public test user registration should succeed, got ${register.status}`);
  const cookie = String(register.headers.get("set-cookie") || "").split(";", 1)[0];
  assert(cookie, "public test user registration should set a session cookie");

  const submit = prompt => fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      accept: "application/json",
      cookie,
    },
    body: JSON.stringify({
      type: "generate",
      payload: {
        prompt,
        client_run_id: "route-idempotency-key",
        agent_full: false,
      },
    }),
  });

  const firstResponse = await submit("Build a compact monochrome clock");
  const first = await firstResponse.json();
  assert(firstResponse.ok, `first job submission should succeed, got ${firstResponse.status}: ${JSON.stringify(first)}`);

  const duplicateResponse = await submit("Build a compact monochrome clock");
  const duplicate = await duplicateResponse.json();
  assert(duplicateResponse.ok, `duplicate job submission should succeed, got ${duplicateResponse.status}: ${JSON.stringify(duplicate)}`);
  assert(duplicate.job?.id === first.job?.id, "duplicate route submissions must return the original job");

  const conflictResponse = await submit("Build a different hardware dashboard");
  const conflict = await conflictResponse.json();
  assert(conflictResponse.status === 409, `changed input should return 409, got ${conflictResponse.status}: ${JSON.stringify(conflict)}`);
  assert(conflict.errorType === "idempotency_conflict", `changed input should expose idempotency_conflict, got ${JSON.stringify(conflict)}`);
}, {
  wait: { path: "/api/health" },
  dbPrefix: "vibeboard-job-route-idempotency",
  env: {
    VIBEBOARD_PUBLIC_DEPLOYMENT: "1",
    VIBEBOARD_BILLING_MODE: "free",
    VIBEBOARD_REQUIRE_PHONE_VERIFICATION: "0",
  },
});

console.log("public job route idempotency ok");
