import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createBuildHandle, createBuildRegistry } from "../src/buildRegistry.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "vibeboard-build-isolation-"));

try {
  const registry = createBuildRegistry();
  const contextA = Object.freeze({
    organizationId: "org-a",
    projectId: "project-a",
    actorId: "user-a",
    requestId: "request-a",
  });
  const contextB = Object.freeze({
    organizationId: "org-b",
    projectId: "project-b",
    actorId: "user-b",
    requestId: "request-b",
  });
  const buildA = createBuildHandle({ context: contextA, jobId: "job-a", buildId: "build-a", generatedRoot: root });
  const buildB = createBuildHandle({ context: contextB, jobId: "job-b", buildId: "build-b", generatedRoot: root });

  assert.notEqual(buildA.workspaceDir, buildB.workspaceDir, "different jobs must use different workspaces");
  assert.equal(buildA.id, "build-a");
  assert.equal(buildB.id, "build-b");
  assert.match(buildA.workspaceDir.replaceAll("\\", "/"), /jobs\/job-a\/build-a$/);
  assert.match(buildB.workspaceDir.replaceAll("\\", "/"), /jobs\/job-b\/build-b$/);

  const fileNames = ["index.html", "style.css", "app.js", "hardware_app.py", "manifest.json"];
  await Promise.all([buildA, buildB].map(async (build, index) => {
    await fs.mkdir(build.workspaceDir, { recursive: true });
    await new Promise(resolve => setTimeout(resolve, index === 0 ? 20 : 5));
    await Promise.all(fileNames.map(name => fs.writeFile(
      path.join(build.workspaceDir, name),
      `${build.id}:${name}`,
      "utf8",
    )));
    build.files = Object.fromEntries(await Promise.all(fileNames.map(async name => [
      name,
      await fs.readFile(path.join(build.workspaceDir, name), "utf8"),
    ])));
    registry.rememberBuild(build);
  }));

  assert.equal(registry.getBuildById("build-a"), buildA);
  assert.equal(registry.getBuildById("build-b"), buildB);
  assert.equal(registry.getBuildById("build-a").files["app.js"], "build-a:app.js");
  assert.equal(registry.getBuildById("build-b").files["app.js"], "build-b:app.js");
  assert.equal(registry.getBuildById("build-a").context.organizationId, "org-a");
  assert.equal(registry.getBuildById("build-b").context.organizationId, "org-b");

  registry.setCurrentBuild(buildB);
  assert.equal(registry.currentBuild.id, "build-b", "legacy current build remains a read alias");
  assert.equal(registry.getBuildById("build-a").id, "build-a", "legacy alias must not remove earlier builds");

  console.log("build handle isolation ok");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
