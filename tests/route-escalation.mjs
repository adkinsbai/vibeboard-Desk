import assert from "node:assert/strict";

import {
  detectRouteEscalation,
  promoteRouteProfile,
} from "../src/routeEscalation.mjs";

const fastPatchProfile = {
  route: "fast_patch",
  score: 12,
  confidence: 0.8,
  reasons: ["single_file_patch"],
  hard_gates: [],
  max_model_turns: 4,
  max_verification_attempts: 1,
  repair_attempts: 0,
  requires_confirmation: true,
};

{
  const escalation = detectRouteEscalation({
    routeProfile: fastPatchProfile,
    toolName: "edit_file",
    args: { path: "style.css" },
    result: "✅ updated",
    touchedFileCount: 3,
    fileRevision: 3,
  });

  assert(escalation, "multi-file work should promote a fast patch");
  assert.equal(escalation.profile.route, "guided_build");
  assert.equal(escalation.profile.max_model_turns, 8);
  assert.equal(escalation.escalation.from_route, "fast_patch");
  assert.equal(escalation.escalation.to_route, "guided_build");
  assert.equal(escalation.escalation.reason, "multi_file_scope_discovered");
}

{
  const escalation = detectRouteEscalation({
    routeProfile: {
      ...fastPatchProfile,
      route: "guided_build",
      max_model_turns: 8,
      max_verification_attempts: 2,
    },
    toolName: "deploy_to_device",
    args: { confirmation: "yes" },
    result: "deploy requested",
    touchedFileCount: 2,
  });

  assert(escalation, "deploy work should promote to full agent");
  assert.equal(escalation.profile.route, "full_agent");
  assert.equal(escalation.profile.max_model_turns, 12);
  assert.equal(escalation.escalation.to_route, "full_agent");
  assert.equal(escalation.escalation.reason, "hard_dependency_discovered");
}

{
  const escalation = detectRouteEscalation({
    routeProfile: {
      ...fastPatchProfile,
      route: "full_agent",
      max_model_turns: 12,
      max_verification_attempts: 3,
    },
    toolName: "edit_file",
    args: { path: "app.js" },
    result: "✅ updated",
    touchedFileCount: 6,
  });

  assert.equal(escalation, null, "full_agent should not promote further");
}

{
  const promoted = promoteRouteProfile(fastPatchProfile, "full_agent", "manual_escalation", {
    tool: "ssh_exec",
    touchedFileCount: 4,
    fileRevision: 5,
  });

  assert(promoted, "promoteRouteProfile should return a new profile");
  assert.equal(promoted.profile.route, "full_agent");
  assert.equal(promoted.profile.max_model_turns, 12);
  assert.equal(promoted.escalation.schema_version, "task-route-escalation.v1");
  assert.equal(promoted.escalation.tool, "ssh_exec");
  assert.equal(promoted.escalation.touched_file_count, 4);
}

console.log("PASS route escalation");
