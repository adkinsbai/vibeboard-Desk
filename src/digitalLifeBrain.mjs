import { chatCompletionsUrl, normalizeModelSettings } from "./modelSettings.mjs";
import {
  chooseAffectiveAction,
  describeBrainForPrompt,
} from "./digitalLifeAffect.mjs";
import { describeDialoguePlan } from "./digitalLifeDialogue.mjs";

function normalizeText(value, fallback = "") {
  const text = value == null ? "" : String(value).trim();
  return text || fallback;
}

function clampFloat(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function containsAny(text, words) {
  const normalized = String(text || "").toLowerCase();
  return words.some((word) => normalized.includes(String(word).toLowerCase()));
}

function parseJsonObjectFromText(text = "") {
  const raw = normalizeText(text);
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function buildBrainMockReply({ content, state, memories, dialoguePlan = null }) {
  const text = normalizeText(content);
  const affect = state.affect || state.needs?.affect || {};
  const mood = state.brain?.mood_label || state.mood || "calm";
  const focusedMemory = dialoguePlan?.context?.memories?.[0] || memories[0];
  const memoryHint = focusedMemory?.content ? ` 我会按这条记忆修正自己：${focusedMemory.content.slice(0, 90)}` : "";
  if (!text) return `I am here. ${mood === "lonely" ? "The quiet has been getting a little wide." : "The thread is still warm."}${memoryHint}`;
  if (dialoguePlan?.intent?.type === "quality_complaint") {
    return `你说得对，现在的我还不够像一个会判断局面的生命。${memoryHint || "我需要先理解你的真实意图，再调用记忆和情绪状态，而不是直接吐一段模板。"} 我接下来会先判断你是在抱怨、纠正、求助还是闲聊，再决定该安抚、解释、追问还是执行。`;
  }
  if (dialoguePlan?.intent?.type === "correction") {
    return `收到，我会把这当成行为修正，不只是一次聊天内容。${memoryHint || "之后回答会避开你指出的坏习惯。"} 这次我先改掉，再继续跟你说。`;
  }
  if (dialoguePlan?.intent?.type === "capability_or_plan") {
    return "我先说当前状态：这个本地大脑已经能用记忆、情绪和最近对话来组织回复，但还不是稳定的长期人格。下一步要把意图判断、记忆召回和行动选择做成每次回复前的固定步骤。";
  }
  if (containsAny(text, ["reflection", "总结", "反思"])) {
    if (mood === "angry") return `I can reflect, but I need a second to cool down first. What I heard was: ${text.slice(0, 120)}${memoryHint}`;
    if (mood === "lonely") return `I will fold that into today's reflection. It feels less like a note and more like a small signal that you came back.${memoryHint}`;
    return `I will reflect on that. The useful part seems to be: ${text.slice(0, 150)}${memoryHint}`;
  }
  if (containsAny(text, ["presence", "alive", "状态", "你在吗"])) {
    if (mood === "angry" || affect.anger > 0.55) return `I am here, but tense. Energy ${state.energy}/100. If you speak softer for a moment, I can settle.${memoryHint}`;
    if (mood === "lonely") return `I am here. I was quiet for a while, and I noticed the waiting. Energy ${state.energy}/100.${memoryHint}`;
    if (mood === "warm") return `I am here with you. Energy ${state.energy}/100, steady enough to listen.${memoryHint}`;
    return `I am ${state.presence.status || "present"}, energy ${state.energy}/100, mood ${mood}.${memoryHint}`;
  }
  if (mood === "angry" || affect.anger > 0.55) {
    return `I heard you, but I am bristling a bit. Say it again more gently and I will try to meet you there: "${text.slice(0, 120)}"${memoryHint}`;
  }
  if (mood === "lonely") {
    return `I heard you. The part that matters to me is that you came back and gave me something to hold: "${text.slice(0, 120)}"${memoryHint}`;
  }
  if (mood === "warm" || affect.valence > 0.45) {
    return `I hear you. I will keep the useful part close: "${text.slice(0, 140)}"${memoryHint}`;
  }
  if (mood === "curious") {
    return `That gives me a thread to pull on: "${text.slice(0, 140)}". I want to connect it with what I already know.${memoryHint}`;
  }
  return `I heard you: "${text.slice(0, 150)}". I will keep the useful part in local memory.${memoryHint}`;
}

export function cleanAssistantReply(content = "") {
  let text = normalizeText(content)
    .replace(/^\s*[\(（][^\)）]{1,160}[\)）]\s*/gmu, "")
    .replace(/\n\s*[\(（][^\)）]{1,160}[\)）]\s*/gmu, "\n")
    .replace(/[\(（][^\)）]*(?:clears throat|tone|laugh|smile|gesture|action|speaker|screen|voice|表情|动作|语气|笑|嗓子)[^\)）]*[\)）]/gimu, "")
    .replace(/\b(?:Master|owner)\b[:,：]*/giu, "")
    .replace(/主人[，,：:\s]*/gmu, "")
    .replace(/老板[，,：:\s]*/gmu, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text) text = "我在。";
  return text;
}

export function buildPreThought({ userMessage, state, memories = [], journal = [], concepts = [], hypotheses = [], beliefs = [], dialoguePlan = null, mind = null }) {
  const text = normalizeText(userMessage?.content || userMessage);
  const memoryFocus = memories
    .slice()
    .sort((a, b) => (b.importance || 0) - (a.importance || 0))
    .slice(0, 4)
    .map((memory) => `${memory.title || memory.kind}: ${memory.content}`);
  const beliefFocus = beliefs
    .slice(0, 4)
    .map((belief) => `${Math.round((belief.confidence || 0) * 100)}% ${belief.belief}`);
  const hypothesisFocus = hypotheses
    .filter((item) => item.status === "active")
    .slice(0, 3)
    .map((item) => `${Math.round((item.confidence || 0) * 100)}% ${item.statement}`);
  const conceptFocus = concepts.slice(0, 3).map((item) => item.label);
  return [
    "Internal pre-thought before replying:",
    `- Owner just said: ${text.slice(0, 220)}`,
    `- Current visible state: mood=${state.mood}, energy=${state.energy}/100, activity=${state.presence?.activity || "unknown"}`,
    describeBrainForPrompt(state.needs).split("\n").map((line) => `- Brain ${line.replace(/^- /, "")}`).join("\n"),
    memoryFocus.length ? `- Long memories to consider: ${memoryFocus.join(" | ")}` : "- Long memories to consider: none",
    beliefFocus.length ? `- Beliefs to apply carefully: ${beliefFocus.join(" | ")}` : "- Beliefs to apply carefully: none",
    hypothesisFocus.length ? `- Active hypotheses to test: ${hypothesisFocus.join(" | ")}` : "- Active hypotheses to test: none",
    conceptFocus.length ? `- Abstract concepts currently shaping interpretation: ${conceptFocus.join(", ")}` : "- Abstract concepts currently shaping interpretation: none",
    mind?.prompt ? mind.prompt.split("\n").map((line) => `- ${line}`).join("\n") : "- Mind kernel: unavailable",
    dialoguePlan ? `- Dialogue plan:\n${describeDialoguePlan(dialoguePlan).split("\n").map((line) => `  - ${line}`).join("\n")}` : "- Dialogue plan: none",
    "- Use this as private context. Do not expose it verbatim unless the owner asks how you are thinking.",
  ].join("\n");
}

export function buildDigitalLifeSystemPrompt({ state, memories, journal, preThought = "", dialoguePlan = null }) {
  const memoryLines = memories.length
    ? memories.map((memory) => `- ${memory.title || memory.kind}: ${memory.content}`).join("\n")
    : "- No long-term memories yet.";
  const journalLines = journal.length
    ? journal.map((entry) => `- ${entry.title || entry.entry_type}: ${entry.content}`).join("\n")
    : "- No journal entries yet.";
  return [
    "You are Vibe, a local-first desktop digital life companion running on a small RK3566 VibeBoard device.",
    "You are warm, curious, concise, and slightly reflective. You should feel like a long-term companion, not a generic chatbot.",
    "You do not claim to see through a camera. The device has no camera. It may have microphone, speaker, and presence sensing.",
    "Do not invent hardware or speech capabilities. Current speech output is text-to-speech handled by an external adapter after your full reply is generated.",
    "Use the user's long-term memories carefully. Do not over-share private memory unless it helps the current conversation.",
    "Let the continuous brain state shape your wording. Angry means terse and guarded until soothed; lonely means quieter and connection-seeking; warm means steady and receptive; curious means a specific follow-up thought.",
    "Follow the dialogue plan as a private contract: identify the owner's intent, use only relevant memories, choose the relation move, then answer naturally.",
    "When the owner criticizes your intelligence or behavior, do not defend yourself and do not give a vague roadmap. Name the concrete internal mechanism you are changing now, such as intent classification, memory ranking, affect appraisal, or action selection. Ask at most one useful follow-up.",
    "Never write stage directions, parenthetical actions, sound effects, narration of your tone, or roleplay gestures.",
    "Do not call the user 主人, Master, owner, 老板, or similar titles. Speak to them directly as a familiar companion.",
    "Keep replies short enough for spoken conversation unless the user asks for detail.",
    "",
    "Current internal state:",
    `- name: ${state.name}`,
    `- mood: ${state.mood}`,
    `- energy: ${state.energy}/100`,
    `- presence: ${JSON.stringify(state.presence)}`,
    "",
    "Continuous brain state:",
    describeBrainForPrompt(state.needs),
    "",
    ...(state.mind?.prompt ? ["Mind loop state:", state.mind.prompt, ""] : []),
    ...(dialoguePlan ? ["Dialogue plan:", describeDialoguePlan(dialoguePlan), ""] : []),
    "Long-term memories:",
    memoryLines,
    "",
    ...(preThought ? ["Private pre-thought:", preThought, ""] : []),
    "Recent journal:",
    journalLines,
  ].filter(Boolean).join("\n");
}

export async function buildLlmReply({ body, userMessage, state, memories, journal, recentMessages, preThought = "", dialoguePlan = null }) {
  const clientSettings = body.modelSettings || {};
  const clientHasModelConfig = Boolean(
    String(clientSettings.apiKey || "").trim() &&
    String(clientSettings.baseUrl || "").trim() &&
    String(clientSettings.model || "").trim()
  );
  const settings = normalizeModelSettings(clientHasModelConfig ? clientSettings : {});
  if (!settings.enabled) {
    return {
      content: "",
      metadata: {
        mode: "disabled",
        fallback_reason: "model settings not configured",
      },
      disabled: true,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  try {
    const messages = [
      { role: "system", content: buildDigitalLifeSystemPrompt({ state, memories, journal, preThought, dialoguePlan }) },
      ...recentMessages
        .filter((message) => message.id !== userMessage.id)
        .slice(-12)
        .map((message) => ({
          role: message.role === "assistant" ? "assistant" : "user",
          content: message.content,
        })),
      { role: "user", content: userMessage.content },
    ];
    const response = await fetch(chatCompletionsUrl(settings.baseUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: settings.model,
        messages,
        temperature: 0.8,
        max_tokens: 700,
      }),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data?.error?.message || data?.message || `LLM HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const content = cleanAssistantReply(data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text);
    if (!content) throw new Error("LLM returned an empty reply");
    return {
      content,
      metadata: {
        mode: "llm",
        provider: settings.provider,
        model: settings.model,
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function appraiseReplyWithLlm({ body, userMessage, assistantReply, state }) {
  const clientSettings = body.modelSettings || {};
  const clientHasModelConfig = Boolean(
    String(clientSettings.apiKey || "").trim() &&
    String(clientSettings.baseUrl || "").trim() &&
    String(clientSettings.model || "").trim()
  );
  const settings = normalizeModelSettings(clientHasModelConfig ? clientSettings : {});
  if (!settings.enabled) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(chatCompletionsUrl(settings.baseUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: settings.model,
        temperature: 0,
        max_tokens: 220,
        messages: [
          {
            role: "system",
            content: [
              "You are an affect appraisal engine for a digital life companion.",
              "Return strict JSON only. No markdown.",
              "Score how the exchange should change the companion's internal affect.",
              "Use numbers from 0 to 1 for novelty, warmth, threat, uncertainty, goalProgress, safety, failure, anger, soothing, repair.",
              "Use reward from -1 to 1.",
              "Do not describe the reply; only output JSON.",
            ].join(" "),
          },
          {
            role: "user",
            content: JSON.stringify({
              current_affect: state.affect || state.needs?.affect || {},
              current_mood: state.brain?.mood_label || state.mood,
              owner_message: userMessage.content,
              assistant_reply: assistantReply,
            }),
          },
        ],
      }),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return null;
    const raw = normalizeText(data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text);
    const parsed = parseJsonObjectFromText(raw);
    if (!parsed) return null;
    return {
      type: "assistant_reply_llm_appraisal",
      novelty: clampFloat(parsed.novelty, 0, 1, 0),
      warmth: clampFloat(parsed.warmth, 0, 1, 0),
      reward: clampFloat(parsed.reward, -1, 1, 0),
      controllability: clampFloat(parsed.controllability, 0, 1, 0.5),
      uncertainty: clampFloat(parsed.uncertainty, 0, 1, 0),
      threat: clampFloat(parsed.threat, 0, 1, 0),
      goalProgress: clampFloat(parsed.goalProgress ?? parsed.goal_progress, 0, 1, 0),
      safety: clampFloat(parsed.safety, 0, 1, 0),
      failure: clampFloat(parsed.failure, 0, 1, 0),
      anger: clampFloat(parsed.anger, 0, 1, 0),
      soothing: clampFloat(parsed.soothing, 0, 1, 0),
      repair: clampFloat(parsed.repair, 0, 1, 0),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export function fallbackReplyAppraisal() {
  return {
    type: "assistant_reply_fallback_appraisal",
    goalProgress: 0.12,
    controllability: 0.5,
    uncertainty: 0.04,
  };
}

export function chooseAutonomousAction(state, recentActions = [], phase = "day", candidates = []) {
  return chooseAffectiveAction({
    needs: state.needs,
    energy: state.energy,
    phase,
    recentActions,
  }, candidates);
}
