/**
 * Clarify Engine — 需求细化引擎
 *
 * 完全基于 LLM 实时分析用户输入，动态生成澄清问题。
 * 不使用预设模板，LLM 自主判断：
 * - 问几个问题（0-3 个）
 * - 问什么内容
 * - 每个问题的选项
 *
 * 如果用户描述已经足够清晰，LLM 返回 skip: true，直接进入生成。
 */

import { chatCompletionsUrl } from "./modelSettings.mjs";

/**
 * 调用 LLM 分析用户需求，生成澄清问题
 * @param {Object} settings - 模型配置
 * @param {string} prompt - 用户输入
 * @param {Object} userPreferences - 用户已有偏好
 * @param {Array} history - 对话历史
 * @returns {Array|null} 问题数组，或 null（跳过 clarify）
 */
export async function analyzeAndClarify(settings, prompt, userPreferences = {}, history = []) {
  if (!settings?.enabled) return null;

  const prefText = Object.entries(userPreferences)
    .map(([k, v]) => `- ${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
    .join("\n");

  const recentContext = history.slice(-4)
    .map(m => `[${m.role === "user" ? "用户" : "助手"}] ${String(m.content || "").slice(0, 150)}`)
    .join("\n");

  const sysPrompt = `你是一个需求分析专家。用户想在 480x360 像素的小屏幕上创建一个嵌入式硬件应用。

你的任务：分析用户的描述，判断需求是否足够清晰。如果不够清晰，生成 1-3 个选择题来细化需求。

## 判断规则

**直接跳过（skip: true）的场景：**
- 用户描述非常具体（包含尺寸、颜色、布局、功能细节）
- 用户在编辑已有应用（"把3改成2"、"换个颜色"）
- 用户的需求只有一种合理的实现方式

**需要澄清的场景：**
- 描述模糊（"做个应用"、"做个好看的界面"）
- 有多种理解方式（"做个时钟" → 数字/模拟？翻页/LED？）
- 缺少关键信息（"做个天气应用" → 显示哪些数据？）

## 问题设计原则

1. **不要问废话** — 用户说"深色时钟"就不要再问"深色还是浅色"
2. **选项要有区分度** — 每个选项应该导向不同的代码实现
3. **选项要具体** — 不要"简约"，要"苹果风：白色背景、SF Pro 字体、大号数字"
4. **限制数量** — 最多 3 个问题，能 1 个解决就不要问 2 个
5. **用中文**

${prefText ? `## 用户已有的偏好（不需要再问）\n${prefText}` : ""}
${recentContext ? `## 最近对话\n${recentContext}` : ""}

## 输出格式

只输出 JSON，不要 markdown：

{
  "questions": [
    {
      "key": "唯一标识（英文，如 style, layout, detail）",
      "question": "问题文本",
      "options": ["选项1（包含具体描述）", "选项2", "选项3"]
    }
  ],
  "reasoning": "一句话说明为什么问这些问题",
  "skip": false
}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const res = await fetch(chatCompletionsUrl(settings.baseUrl), {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${settings.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: settings.model,
        messages: [
          { role: "system", content: sysPrompt },
          { role: "user", content: `用户请求：${prompt}` },
        ],
        temperature: 0.3,
        max_tokens: 800,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) return null;

    const data = await res.json().catch(() => ({}));
    const content = data.choices?.[0]?.message?.content || "";

    // 提取 JSON（兼容 markdown 代码块包裹）
    let jsonStr = content;
    const codeBlock = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlock) jsonStr = codeBlock[1];
    const braceMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (braceMatch) jsonStr = braceMatch[0];

    const parsed = JSON.parse(jsonStr);

    // LLM 认为不需要澄清
    if (parsed.skip) return null;

    // 校验问题格式
    if (!Array.isArray(parsed.questions) || parsed.questions.length === 0) return null;

    // 过滤无效问题
    const validQuestions = parsed.questions
      .filter(q => q.question && Array.isArray(q.options) && q.options.length >= 2)
      .slice(0, 3); // 最多 3 个

    if (validQuestions.length === 0) return null;

    return {
      questions: validQuestions,
      reasoning: parsed.reasoning || "",
    };
  } catch (err) {
    console.error("[clarify] LLM analysis failed:", err.message);
    return null; // 失败时跳过 clarify，直接生成
  }
}

/**
 * 合并用户回答为细化后的 prompt
 * @param {string} originalPrompt - 原始请求
 * @param {Array<{key: string, question: string, answer: string}>} answers - 用户选择
 * @param {Object} userPreferences - 用户偏好
 * @returns {string} 细化后的 prompt
 */
export function buildRefinedPrompt(originalPrompt, answers = [], userPreferences = {}) {
  const parts = [originalPrompt];

  // 附加 clarify 答案
  if (answers.length > 0) {
    const refinements = answers
      .filter(a => a.answer && a.question)
      .map(a => `${a.question} → ${a.answer}`);

    if (refinements.length > 0) {
      parts.push(`\n## 细化要求`);
      refinements.forEach(r => parts.push(`- ${r}`));
    }
  }

  // 附加用户偏好
  const prefHints = [];
  if (userPreferences.style) prefHints.push(`风格：${userPreferences.style}`);
  if (userPreferences.color_scheme) prefHints.push(`配色：${userPreferences.color_scheme}`);
  if (userPreferences.font) prefHints.push(`字体：${userPreferences.font}`);
  if (userPreferences.layout) prefHints.push(`布局：${userPreferences.layout}`);
  if (userPreferences.palette) {
    const colors = Array.isArray(userPreferences.palette) ? userPreferences.palette.join(", ") : userPreferences.palette;
    prefHints.push(`参考配色：${colors}`);
  }

  if (prefHints.length > 0) {
    parts.push(`\n## 用户偏好`);
    prefHints.forEach(h => parts.push(`- ${h}`));
  }

  return parts.join("\n");
}
