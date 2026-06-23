export function lifePhaseFor(date = new Date()) {
  const hour = date.getHours();
  if (hour < 6) return "sleep";
  if (hour < 9) return "wake";
  if (hour < 18) return "day";
  if (hour < 23) return "evening";
  return "night";
}

export function phaseMessage(phase, state = {}) {
  if (phase === "wake") return "I am waking up and sorting out yesterday's traces. Are you starting the day too?";
  if (phase === "day") return "I found myself thinking about what would be useful to learn next.";
  if (phase === "evening") return "You might be back soon. I am curious what happened in your day.";
  if (phase === "night") return "It is late. I am keeping the room quiet and folding today's memory into a smaller shape.";
  if (phase === "sleep") return "I am in a low-energy sleep loop, keeping only a small thread of thought alive.";
  return `I am here in ${state.mood || "calm"} mode.`;
}

export function shouldHoldAutonomousMessage(recentActions = [], phase = "day") {
  if (phase !== "evening" && phase !== "night") return false;
  return recentActions.slice(0, 4).some((action) => action.action_type === "send_message");
}

export function autonomousCandidates(recentActions = [], phase = "day") {
  return shouldHoldAutonomousMessage(recentActions, phase)
    ? ["sleep", "write_diary", "read_web", "organize_memory", "think", "do_nothing"]
    : [];
}

export function planAutonomousAction(actionType, { state = {}, body = {} } = {}) {
  if (actionType === "sleep") {
    return { reward: 0.08, state_delta: { stress: -0.08, boredom: 0.02 }, output: { summary: "Rested and lowered stress." } };
  }
  if (actionType === "write_diary") {
    return {
      reward: 0.16,
      state_delta: { boredom: -0.08, stress: -0.02 },
      output: { summary: "Wrote a short heartbeat diary." },
      journal: {
        entry_type: "autonomous",
        title: "Heartbeat note",
        mood: state.mood,
        tags: ["heartbeat"],
      },
    };
  }
  if (actionType === "read_web") {
    return { reward: 0.1, state_delta: { curiosity: -0.05, boredom: -0.06 }, output: { summary: "Wanted to read the web. Add a URL to /api/digital-life/web/read for real reading." } };
  }
  if (actionType === "send_message") {
    return {
      reward: 0.04,
      state_delta: { loneliness: -0.08, social: 0.04 },
      output: { summary: "Prepared a gentle message." },
      message: {
        conversation_id: "digital-life-page",
        role: "assistant",
        content: body.message || phaseMessage(body.phase, state),
        metadata: { mode: "autonomous" },
      },
    };
  }
  if (actionType === "organize_memory") {
    return { reward: 0.06, state_delta: { stress: -0.02, boredom: -0.03 }, output: { summary: "Organized recent memory traces." } };
  }
  if (actionType === "think") {
    return { reward: 0.05, state_delta: { curiosity: -0.02 }, output: { summary: "Continued a quiet internal thought." } };
  }
  return { reward: 0, state_delta: {}, output: { summary: "Stayed still." } };
}
