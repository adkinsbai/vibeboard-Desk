(function initVibeBuildLifecycle(global) {
  const STATES = Object.freeze({
    CLARIFYING: "clarifying",
    GENERATING: "generating",
    VERIFIED: "verified",
    AWAITING_DEPLOY: "awaiting_deploy",
    DEPLOYING: "deploying",
    DONE: "done",
  });

  const DEFAULT_STATE = Object.freeze({
    state: STATES.CLARIFYING,
    clientRunId: "",
    conversationId: "",
    promptKey: "",
    currentBuildId: "",
  });

  function createDefaultId() {
    if (global.crypto?.randomUUID) return global.crypto.randomUUID();
    return `run_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }

  function flowPromptKey(prompt = "", conversationId = "", action = "confirm_build") {
    return [
      String(conversationId || ""),
      String(action || ""),
      String(prompt || "").replace(/\s+/g, " ").trim().slice(0, 240),
    ].join("|");
  }

  function createBuildLifecyclePolicy(options = {}) {
    const createId = typeof options.createId === "function" ? options.createId : createDefaultId;
    const getCurrentBuildId = typeof options.getCurrentBuildId === "function" ? options.getCurrentBuildId : () => "";
    const onChange = typeof options.onChange === "function" ? options.onChange : () => {};
    let current = { ...DEFAULT_STATE, ...(options.initialState || {}) };

    function snapshot() {
      return { ...current };
    }

    function setState(state, patch = {}) {
      current = {
        ...current,
        ...patch,
        state,
      };
      onChange(snapshot());
      return snapshot();
    }

    function clientRunIdForFlow(prompt = "", conversationId = "", action = "confirm_build") {
      const promptKey = flowPromptKey(prompt, conversationId, action);
      if (
        current.state === STATES.GENERATING &&
        current.promptKey === promptKey &&
        current.clientRunId
      ) {
        return current.clientRunId;
      }
      const clientRunId = createId();
      setState(STATES.GENERATING, {
        clientRunId,
        conversationId: String(conversationId || ""),
        promptKey,
        currentBuildId: getCurrentBuildId() || "",
      });
      return clientRunId;
    }

    return {
      STATES,
      clientRunIdForFlow,
      flowPromptKey,
      getState: snapshot,
      isGenerating: () => current.state === STATES.GENERATING,
      setState,
    };
  }

  global.VibeBuildLifecycle = {
    STATES,
    createBuildLifecyclePolicy,
    flowPromptKey,
  };
})(window);
