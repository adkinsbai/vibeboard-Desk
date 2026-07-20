export function compactAgentMessages(messages = [], {
  maxChars = 48000,
  maxToolResultChars = 6000,
  keepRecentPairs = 8,
} = {}) {
  const cloned = messages.map(message => ({
    ...message,
    tool_calls: Array.isArray(message.tool_calls)
      ? message.tool_calls.map(call => ({ ...call, function: { ...call.function } }))
      : message.tool_calls,
    content: message.role === "tool"
      ? truncateToolResult(message.content, maxToolResultChars)
      : message.content,
  }));
  const system = cloned.filter(message => message.role === "system");
  const body = cloned.filter(message => message.role !== "system");
  const units = buildMessageUnits(body);
  const selected = [];
  let size = jsonSize(system);
  const latestUserUnitIndex = findLastIndex(units, unit => unit.some(message => message.role === "user"));

  for (let index = units.length - 1; index >= 0; index -= 1) {
    const unit = units[index];
    const unitSize = jsonSize(unit);
    const mustKeep = selected.length < keepRecentPairs || index === latestUserUnitIndex;
    if (!mustKeep && size + unitSize > maxChars) continue;
    selected.unshift(unit);
    size += unitSize;
    if (size >= maxChars && selected.length >= keepRecentPairs && index < latestUserUnitIndex) break;
  }

  const compacted = [...system, ...selected.flat()];
  if (jsonSize(compacted) <= maxChars + 1000) return compacted;
  return trimOldestOptionalUnits(system, selected, latestUserUnitIndex, maxChars);
}

function buildMessageUnits(messages) {
  const units = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role !== "assistant" || !Array.isArray(message.tool_calls) || !message.tool_calls.length) {
      units.push([message]);
      continue;
    }
    const ids = new Set(message.tool_calls.map(call => call.id));
    const unit = [message];
    while (index + 1 < messages.length
      && messages[index + 1].role === "tool"
      && ids.has(messages[index + 1].tool_call_id)) {
      unit.push(messages[index + 1]);
      index += 1;
    }
    units.push(unit);
  }
  return units;
}

function trimOldestOptionalUnits(system, units, latestUserUnitIndex, maxChars) {
  const kept = [...units];
  while (kept.length > 1 && jsonSize([...system, ...kept.flat()]) > maxChars + 1000) {
    const removeAt = kept.findIndex((unit, index) => (
      index !== latestUserUnitIndex && !unit.some(message => message.role === "user")
    ));
    if (removeAt < 0) break;
    kept.splice(removeAt, 1);
  }
  return [...system, ...kept.flat()];
}

function truncateToolResult(value, maxChars) {
  const text = String(value || "");
  if (text.length <= maxChars) return text;
  const marker = `[tool-result-truncated original_chars=${text.length}]`;
  return `${text.slice(0, Math.max(0, maxChars - marker.length - 1))}\n${marker}`;
}

function jsonSize(value) {
  return JSON.stringify(value).length;
}

function findLastIndex(values, predicate) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index], index)) return index;
  }
  return -1;
}
