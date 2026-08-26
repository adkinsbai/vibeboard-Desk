import path from "node:path";

export function createBuildHandle({
  context = {},
  jobId = "",
  buildId = "",
  generatedRoot = "",
  workspaceDir = "",
  files = {},
  ...metadata
} = {}) {
  const id = requiredId(buildId, "buildId");
  const executionJobId = requiredId(jobId || context.jobId || context.requestId || `direct-${id}`, "jobId");
  const dir = workspaceDir
    ? path.resolve(workspaceDir)
    : path.join(path.resolve(requiredId(generatedRoot, "generatedRoot")), "jobs", safeSegment(executionJobId), safeSegment(id));
  return {
    ...metadata,
    id,
    buildId: id,
    jobId: executionJobId,
    context: Object.freeze({ ...(context || {}) }),
    workspaceDir: dir,
    dir,
    files: { ...(files || {}) },
  };
}

export function createBuildRegistry() {
  let currentBuild = null;
  let activeEndpoint = null;
  let lastDeploy = null;
  const buildsById = new Map();
  const buildsByConversationId = new Map();

  function rememberBuild(build) {
    if (!build?.id) return build || null;
    buildsById.set(build.id, build);
    if (build.conversationId) {
      buildsByConversationId.set(build.conversationId, build);
    }
    return build;
  }

  return {
    get currentBuild() {
      return currentBuild;
    },
    setCurrentBuild(build) {
      currentBuild = rememberBuild(build);
      return currentBuild;
    },
    getBuild(id) {
      return buildsById.get(id) || null;
    },
    getBuildById(id) {
      return buildsById.get(id) || null;
    },
    getConversationBuild(conversationId) {
      return buildsByConversationId.get(conversationId) || null;
    },
    rememberBuild,
    createBuildHandle(input = {}) {
      return rememberBuild(createBuildHandle(input));
    },
    get activeEndpoint() {
      return activeEndpoint;
    },
    setActiveEndpoint(endpoint) {
      activeEndpoint = endpoint || null;
      return activeEndpoint;
    },
    get lastDeploy() {
      return lastDeploy;
    },
    setLastDeploy(deploy) {
      lastDeploy = deploy || null;
      return lastDeploy;
    },
  };
}

function requiredId(value, name) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${name} is required`);
  if (/\p{Cc}/u.test(text)) throw new Error(`${name} contains control characters`);
  return text;
}

function safeSegment(value) {
  return requiredId(value, "path segment")
    .replaceAll("\\", "_")
    .replaceAll("/", "_")
    .replace(/[<>:"|?*]/g, "_");
}
