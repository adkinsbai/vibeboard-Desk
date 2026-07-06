export function classifyError(error, context = {}) {
  const text = errorText(error);
  const lower = text.toLowerCase();
  const stageHint = String(context.stage || error?.stage || "").trim();
  const type = explicitType(error) || detectType(text, lower, context);
  const profile = ERROR_PROFILES[type] || ERROR_PROFILES.unknown;
  const technicalDetail = cleanTechnicalDetail(error, text);
  return {
    errorType: type,
    errorLabel: profile.label,
    errorStage: stageHint || profile.stage,
    userMessage: profile.userMessage,
    suggestion: profile.suggestion,
    retryable: Boolean(profile.retryable),
    nextActions: profile.nextActions.slice(0, 4),
    technicalDetail,
    statusCode: Number(error?.statusCode || error?.status || profile.statusCode || 500),
  };
}

export function createStructuredError(message, type, extra = {}) {
  const error = new Error(message || ERROR_PROFILES[type]?.label || "Operation failed");
  error.errorType = type;
  Object.assign(error, extra);
  Object.assign(error, classifyError(error, { stage: extra.stage || "" }));
  return error;
}

const ERROR_PROFILES = Object.freeze({
  generate_busy: {
    label: "Another generation is already running",
    stage: "generate",
    userMessage: "当前已经有一个生成任务正在执行，新的任务没有启动，避免两个任务互相覆盖当前构建。",
    suggestion: "等当前任务结束后再开始新任务；如果刚刷新页面，可以先查看当前对话是否已经恢复出最新预览。",
    retryable: true,
    statusCode: 409,
    nextActions: ["等待当前任务完成", "刷新任务状态", "稍后重新提交"],
  },
  no_api_key: {
    label: "AI provider is not configured",
    stage: "model_config",
    userMessage: "当前没有可用的模型 API Key，Agent 无法调用真实模型完成理解或代码生成。",
    suggestion: "在右上角 Model 中配置 API Key，或用环境变量 VIBEBOARD_LLM_API_KEY / DEEPSEEK_API_KEY 启动服务。未配置模型时不会生成应用文件，避免产生与需求无关的模板结果。",
    retryable: false,
    statusCode: 400,
    nextActions: ["打开模型配置", "填写 API Key", "配置后重新生成"],
  },
  llm_auth: {
    label: "AI provider authentication failed",
    stage: "model_call",
    userMessage: "模型服务拒绝了这次请求，通常是 API Key 无效、过期、额度账户不匹配或没有该模型权限。",
    suggestion: "重新检查 API Key、Base URL、模型名和账号权限，然后再次生成。",
    retryable: false,
    statusCode: 502,
    nextActions: ["检查 API Key", "检查模型名", "更换 Provider"],
  },
  llm_quota: {
    label: "AI provider quota is unavailable",
    stage: "model_call",
    userMessage: "模型服务返回额度、余额或配额不足，代码生成在部署设备前就停止了。",
    suggestion: "检查模型账号余额和限额，或切换到另一个可用模型。",
    retryable: false,
    statusCode: 502,
    nextActions: ["检查余额", "切换模型", "稍后重试"],
  },
  llm_rate_limited: {
    label: "AI provider rate limited the request",
    stage: "model_call",
    userMessage: "模型服务限流了当前请求，Agent 还没拿到完整代码。",
    suggestion: "稍等一会儿再试，或换成并发额度更高的模型配置。",
    retryable: true,
    statusCode: 429,
    nextActions: ["稍后重试", "降低并发", "切换模型"],
  },
  llm_timeout: {
    label: "AI model call timed out",
    stage: "model_call",
    userMessage: "模型在规定时间内没有返回结果，生成流程已经停止在模型调用阶段。",
    suggestion: "可以重试一次；如果连续超时，缩短需求、减少上传上下文或切换响应更快的模型。",
    retryable: true,
    statusCode: 504,
    nextActions: ["重试生成", "缩短需求", "切换模型"],
  },
  llm_network: {
    label: "AI provider network is unreachable",
    stage: "model_call",
    userMessage: "服务端无法连接模型 API，可能是 Base URL 错误、DNS/代理问题或网络不可达。",
    suggestion: "检查 Base URL、代理、网络连通性和防火墙设置。",
    retryable: true,
    statusCode: 502,
    nextActions: ["检查 Base URL", "检查网络", "切换 Provider"],
  },
  llm_failed: {
    label: "AI model call failed",
    stage: "model_call",
    userMessage: "模型调用失败，Agent 没有拿到可用的生成结果。",
    suggestion: "查看技术详情中的模型返回信息，修正模型配置或稍后重试。",
    retryable: true,
    statusCode: 502,
    nextActions: ["查看错误详情", "检查模型配置", "重试生成"],
  },
  model_output_invalid: {
    label: "AI model output is invalid",
    stage: "model_output",
    userMessage: "模型返回内容不符合 VibeBoard 代码合同，例如缺少必需文件或不是可解析 JSON。",
    suggestion: "重试生成；如果反复出现，换一个模型或把需求拆得更具体。",
    retryable: true,
    statusCode: 422,
    nextActions: ["重试生成", "换模型", "简化需求"],
  },
  auto_repair_failed: {
    label: "Automatic repair could not finish",
    stage: "auto_repair",
    userMessage: "Agent 已经尝试自动修复部署前的本地验证问题，但仍未通过 L0-L3 验证。",
    suggestion: "请查看技术详情中的最后一次失败原因；如果是需求冲突或缺少素材，请补充信息后重新生成。",
    retryable: true,
    statusCode: 422,
    nextActions: ["查看失败详情", "补充需求", "重新生成"],
  },
  empty_prompt: {
    label: "Prompt is required",
    stage: "intake",
    userMessage: "还没有收到可生成的需求文本。",
    suggestion: "请输入你想在 480x360 小屏上生成的应用，例如天气面板、股票看板或设备状态屏。",
    retryable: false,
    statusCode: 400,
    nextActions: ["补充需求", "选择示例任务"],
  },
  build_context_required: {
    label: "Current build id is required",
    stage: "edit_context",
    userMessage: "This edit must be bound to the current build before VibeBoard can modify existing files.",
    suggestion: "Open the latest preview and submit the edit again with current_build_id.",
    retryable: false,
    statusCode: 409,
    nextActions: ["Open latest preview", "Submit edit again"],
  },
  build_context_missing: {
    label: "Current build context is missing",
    stage: "edit_context",
    userMessage: "This conversation has project files but no saved build id, so VibeBoard cannot safely edit it.",
    suggestion: "Restore or regenerate a complete build before editing.",
    retryable: false,
    statusCode: 409,
    nextActions: ["Restore latest preview", "Regenerate build"],
  },
  build_context_stale: {
    label: "Current build is stale",
    stage: "edit_context",
    userMessage: "This edit was based on an older build and was blocked before it could overwrite newer files.",
    suggestion: "Refresh to the latest preview and submit the edit again.",
    retryable: false,
    statusCode: 409,
    nextActions: ["Refresh preview", "Submit edit again"],
  },
  build_context_incomplete: {
    label: "Current build files are incomplete",
    stage: "edit_context",
    userMessage: "The current build is missing required files, so VibeBoard cannot safely perform a minimal edit.",
    suggestion: "Restore a complete build before editing.",
    retryable: false,
    statusCode: 409,
    nextActions: ["Restore build", "Regenerate build"],
  },
  request_too_large: {
    label: "Request body is too large",
    stage: "intake",
    userMessage: "这次请求或上传资产包太大，后端在生成前拒绝了请求。",
    suggestion: "压缩或拆分资产包，先上传关键素材，再分批补充其它素材。",
    retryable: false,
    statusCode: 413,
    nextActions: ["拆分资产包", "删除超大文件", "重新上传"],
  },
  syntax_error: {
    label: "Generated JavaScript has a syntax error",
    stage: "local_verify",
    userMessage: "生成的 JavaScript 没通过本地语法检查，尚未进入设备部署。",
    suggestion: "重试生成；如果连续失败，保留错误详情用于修复生成器提示词。",
    retryable: true,
    statusCode: 422,
    nextActions: ["重试生成", "查看语法详情"],
  },
  python_syntax: {
    label: "Generated Python has an error",
    stage: "local_verify",
    userMessage: "生成的 hardware_app.py 没通过 Python 检查或运行检查，尚未进入设备部署。",
    suggestion: "重试生成；如果连续失败，检查 hardware_app.py 合同字段是否完整。",
    retryable: true,
    statusCode: 422,
    nextActions: ["重试生成", "查看 Python 详情"],
  },
  python_runtime_unavailable: {
    label: "Python runtime is unavailable",
    stage: "local_verify",
    userMessage: "Cloud verification could not find a Python runtime for hardware_app.py. The generated files may still be valid, but the hardware script execution check was degraded.",
    suggestion: "Keep the cloud check degraded, or install Python in the runtime if you want py_compile and hardware_app.py execution to run on the server.",
    retryable: true,
    statusCode: 503,
    nextActions: ["Retry generation", "View technical details", "Run on a board with Python"],
  },
  hardware_contract: {
    label: "Generated hardware contract is invalid",
    stage: "local_verify",
    userMessage: "生成应用缺少 VibeBoard 必需的硬件合同，例如 hardware-result.json、build_id 或 runtime API。",
    suggestion: "让 Agent 重新生成并保留硬件合同；不要手动删改 hardware_app.py 的合同字段。",
    retryable: true,
    statusCode: 422,
    nextActions: ["重新生成", "检查合同文件"],
  },
  render_failed: {
    label: "480x360 render verification failed",
    stage: "local_verify",
    userMessage: "页面没有通过 480x360 渲染验证，可能是白屏、溢出、资源加载失败或前端运行错误。",
    suggestion: "重试生成，或根据错误详情修复布局尺寸、资源路径和浏览器控制台错误。",
    retryable: true,
    statusCode: 422,
    nextActions: ["重试生成", "检查预览", "查看渲染详情"],
  },
  no_code: {
    label: "Generated app has no code",
    stage: "local_verify",
    userMessage: "当前构建没有可部署的应用代码，不能继续本地验证或部署。",
    suggestion: "先生成一个完整应用，再执行部署。",
    retryable: false,
    statusCode: 400,
    nextActions: ["先生成应用", "选择历史构建"],
  },
  storage_failed: {
    label: "Project storage failed",
    stage: "snapshot",
    userMessage: "项目快照或会话文件保存失败，刷新后可能无法恢复这次生成。",
    suggestion: "检查 runtime 数据库/磁盘权限和剩余空间，然后重试。",
    retryable: true,
    statusCode: 500,
    nextActions: ["检查磁盘空间", "重启服务", "重试生成"],
  },
  storage_corrupt: {
    label: "Project database is corrupted",
    stage: "snapshot",
    userMessage: "本地项目数据库无法读取，可能导致对话、资产或快照恢复失败。",
    suggestion: "先备份 runtime 数据库，再修复或重建数据库文件。",
    retryable: false,
    statusCode: 500,
    nextActions: ["备份数据库", "修复数据库", "重启服务"],
  },
  asset_rejected: {
    label: "Uploaded asset was rejected",
    stage: "assets",
    userMessage: "上传资产没有通过安全或大小检查，因此没有进入生成上下文。",
    suggestion: "检查资产路径、文件类型、压缩包结构和大小限制后重新上传。",
    retryable: false,
    statusCode: 400,
    nextActions: ["检查资产包", "删除危险路径", "分批上传"],
  },
  deploy_failed: {
    label: "Deploy failed",
    stage: "deploy",
    userMessage: "写入硬件时失败；本地生成和验证可能已完成，但真机 L4 没通过。",
    suggestion: "检查设备连接、SSH 凭据、板端服务和部署日志后重试。",
    retryable: true,
    statusCode: 502,
    nextActions: ["检查设备状态", "检查 SSH", "重试部署"],
  },
  deploy_mkdir: {
    label: "Unable to create deploy directory",
    stage: "deploy",
    userMessage: "无法在设备上创建部署目录，可能是权限或磁盘空间问题。",
    suggestion: "检查板端目标目录权限和磁盘空间。",
    retryable: true,
    statusCode: 502,
    nextActions: ["检查板端磁盘", "检查目录权限"],
  },
  deploy_copy: {
    label: "File upload failed",
    stage: "deploy",
    userMessage: "应用文件复制到设备失败，真机部署没有完成。",
    suggestion: "检查网络、SSH/SCP 通道和板端剩余空间后重试。",
    retryable: true,
    statusCode: 502,
    nextActions: ["检查网络", "检查 SSH", "重试部署"],
  },
  deploy_service: {
    label: "Device service restart failed",
    stage: "deploy",
    userMessage: "文件上传后，板端显示服务重启失败。",
    suggestion: "检查 systemctl 服务日志、kiosk 进程和板端运行环境。",
    retryable: true,
    statusCode: 502,
    nextActions: ["查看板端日志", "重启服务", "重试部署"],
  },
  deploy_http: {
    label: "Device HTTP service did not respond",
    stage: "deploy",
    userMessage: "板端 HTTP 服务没有按预期响应，Golden Loop 无法确认真机页面。",
    suggestion: "等待几秒后重试验证；如果仍失败，检查板端 Web 服务和端口。",
    retryable: true,
    statusCode: 502,
    nextActions: ["重试验证", "检查板端 HTTP 服务"],
  },
  timeout: {
    label: "Operation timed out",
    stage: "runtime",
    userMessage: "操作超时，没有在预期时间内完成。",
    suggestion: "可以重试；如果经常超时，缩短任务、检查网络或提高超时配置。",
    retryable: true,
    statusCode: 504,
    nextActions: ["重试", "检查网络", "缩短任务"],
  },
  connection_dropped: {
    label: "Connection dropped",
    stage: "runtime",
    userMessage: "连接在执行过程中断开，任务结果不完整。",
    suggestion: "检查网络稳定性，然后重试。",
    retryable: true,
    statusCode: 502,
    nextActions: ["检查网络", "重试"],
  },
  unknown: {
    label: "Operation failed",
    stage: "runtime",
    userMessage: "执行失败，但当前错误还没有匹配到明确分类。",
    suggestion: "请查看技术详情；如果重复出现，把详情保留下来用于补充错误分类。",
    retryable: true,
    statusCode: 500,
    nextActions: ["查看技术详情", "重试", "反馈错误详情"],
  },
});

function explicitType(error) {
  const value = String(error?.errorType || error?.type || "").trim();
  return ERROR_PROFILES[value] ? value : "";
}

function detectType(text, lower, context = {}) {
  if (/spawn\s+\S*python\S*\s+ENOENT|\bENOENT\b[\s\S]*\bpython\b|PYTHON_RUNTIME_UNAVAILABLE|Python runtime is unavailable|Python was not found|unable to find Python|could not find Python|No Python at|not recognized as an internal or external command|command not found/i.test(text) && /python|py_compile|hardware_app\.py/i.test(text)) return "python_runtime_unavailable";
  if (/another generation|generation.*running|generate_busy|already.*running|in progress/i.test(text)) return "generate_busy";
  if (/Prompt is required|empty.*prompt/i.test(text)) return "empty_prompt";
  if (/larger than|payload too large|request entity too large|HTTP 413|413/i.test(text)) return "request_too_large";
  if (/not configured|no api key|missing api key|NO_API_KEY/i.test(text)) return "no_api_key";
  if (/HTTP\s*(401|403)|status[=:]\s*(401|403)|unauthori[sz]ed|forbidden|invalid api key|authentication|permission denied|无效.*key|鉴权|认证失败/i.test(text)) return "llm_auth";
  if (/insufficient.*quota|quota|balance|billing|credits?|余额不足|额度不足/i.test(text)) return "llm_quota";
  if (/HTTP\s*429|status[=:]\s*429|rate limit|too many requests|限流|频率/i.test(text)) return "llm_rate_limited";
  if (/LLM_TIMEOUT|llm.*timeout|model.*timeout|Timed out after/i.test(text)) return "llm_timeout";
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|fetch failed|getaddrinfo|network|socket hang up/i.test(text) && /llm|model|chat\/completions|provider|api\./i.test(text)) return "llm_network";
  if (/LLM_CALL_FAILED|llm.*fail|model.*fail|chat\/completions|provider=/i.test(text)) return "llm_failed";
  if (/missing index\.html|missing.*style\.css|missing.*app\.js|Model output is missing|not.*valid JSON|JSON.*parse|empty content/i.test(text)) return "model_output_invalid";
  if (/automatic repair|auto repair|repair.*exhausted|修复.*仍未通过|自动修复/i.test(text)) return "auto_repair_failed";
  if (/database disk image is malformed|SQLITE_CORRUPT|malformed database/i.test(text)) return "storage_corrupt";
  if (/SQLITE|database|snapshot|conversation.*save|save.*failed|EACCES|EPERM|ENOENT/i.test(text)) return "storage_failed";
  if (/unsafe ZIP|unsafe path|asset.*reject|unsupported archive|too large.*asset|archive/i.test(text) && /asset|upload|zip|tar|gz/i.test(text)) return "asset_rejected";
  if (/syntax.?error|SyntaxError|unexpected token|node --check|JavaScript parse/i.test(text)) return "syntax_error";
  if (/IndentationError|TabError|NameError|py_compile|hardware_app\.py failed|Python.*(?:error|failed)/i.test(text)) return "python_syntax";
  if (/hardware-result\.json|HARDWARE_|hardware contract|build_id mismatch|required runtime API|available_apis/i.test(text)) return "hardware_contract";
  if (/render|480x360|LAYOUT_OVERFLOW|TEXT_TOO_SMALL|TEXT_CONTRAST_LOW|INTERACTIVE_TARGET_SMALL|page error|console error|blank|white screen|requestfailed|failed resource/i.test(text)) return "render_failed";
  if (/no code|has no code|No generated app/i.test(text)) return "no_code";
  if (/timed?out|timeout/i.test(text)) return context.stage === "model_call" ? "llm_timeout" : "timeout";
  if (/Connection reset|Connection closed|EOFError|socket hang up/i.test(text)) return "connection_dropped";
  if (/mkdir|No space left|ENOSPC/i.test(text)) return "deploy_mkdir";
  if (/scp|upload|copy/i.test(text) && /fail|error/i.test(text)) return "deploy_copy";
  if (/systemctl|service.*restart|Failed to restart/i.test(text)) return "deploy_service";
  if (/HTTP.*(?:502|503|504)|connection refused.*curl/i.test(text)) return "deploy_http";
  if (/Deploy failed/i.test(text)) return "deploy_failed";
  if (/maximum iterations|max iterations|iteration limit/i.test(text)) return "model_output_invalid";
  return "unknown";
}

function errorText(error) {
  const parts = [
    error?.message,
    error?.stack,
    error?.stdout,
    error?.stderr,
    error?.providerMessage,
    error?.technicalDetail,
  ];
  if (error?.cause) {
    parts.push(error.cause?.message, error.cause?.stack, error.cause?.stdout, error.cause?.stderr);
  }
  return parts.filter(Boolean).map(item => String(item)).join("\n");
}

function cleanTechnicalDetail(error, text) {
  const raw = String(error?.technicalDetail || error?.providerMessage || error?.stderr || error?.stdout || error?.message || text || "").trim();
  return redactSecrets(raw).replace(/\s+/g, " ").slice(0, 800);
}

function redactSecrets(value) {
  return String(value || "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/(api[_-]?key["'\s:=]+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(/(sk-[A-Za-z0-9]{6})[A-Za-z0-9._-]+/g, "$1[redacted]");
}
