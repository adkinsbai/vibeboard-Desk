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
    getConversationBuild(conversationId) {
      return buildsByConversationId.get(conversationId) || null;
    },
    rememberBuild,
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
