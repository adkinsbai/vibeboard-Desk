# VibeBoard Agent — 项目交接文档

> 2026-06-10 整理，供 Codex 接手优化

---

## 一、项目概述

VibeBoard 是一个**硬件应用生成器**，为泰山派（RK3566，480x360 屏幕，3 个 GPIO 按钮）生成 Web 应用。

**核心架构：**
- 前端：vanilla HTML/CSS/JS（无框架）
- 后端：Node.js (ESM, .mjs)
- 数据库：sql.js（内存 SQLite）
- AI：Tool-calling Agent（OpenAI function calling 协议）

**项目路径：** `/mnt/c/tmp/vibeboard-linux-prototype/`

---

## 二、已实现功能

### 2.1 Agent 核心（src/agent.mjs）

| 工具 | 功能 | 状态 |
|------|------|------|
| read_file | 读取文件 | ✅ |
| list_files | 列出文件 | ✅ |
| search_code | 搜索代码 | ✅ |
| edit_file | 精准编辑（old_text → new_text） | ✅ |
| create_file | 创建/重写文件 | ✅ |
| verify_syntax | 语法检查（JS 花括号、HTML 引用、Python） | ✅ |
| verify_render | Playwright 截图验证（白屏、JS 错误检测） | ✅ |
| run_hardware | 本地运行 hardware_app.py 验证 JSON 输出 | ✅ |
| ssh_exec | SSH 到泰山派执行命令 | ✅ |
| get_device_logs | 获取设备日志（app/system/python/recent） | ✅ |
| deploy_to_device | SCP 部署到硬件 + 运行 | ✅ |
| check_device_status | 检查设备状态（CPU/内存/进程） | ✅ |
| get_learnings | 查询过去经验 | ✅ |
| record_lesson | 实时记录经验 + 写入 LESSONS.md | ✅ |
| done | 完成（触发自动验证循环） | ✅ |

### 2.2 自动验证循环

```
Agent 调用 done →
  verify_syntax → 失败则注入错误继续循环
  verify_render → 失败则注入错误继续循环
  run_hardware → 失败则注入错误继续循环
  最多 3 次验证尝试
  通过后记录经验到 experienceStore
```

### 2.3 经验记忆系统（src/experienceStore.mjs）

- SQLite 表 `build_experiences`
- 存储：任务类型、成功模式、失败陷阱、修复方法
- 查询：按任务类型检索相关经验
- API：`GET /api/experience?type=clock`

### 2.4 用户偏好记忆（src/memoryStore.mjs）

- SQLite 表 `user_preferences`
- 存储：用户选择的偏好（颜色、风格等）
- API：`GET/POST/DELETE /api/preferences`

### 2.5 对话式构建（src/clarifyEngine.mjs）

- `/api/chat` — 纯对话 LLM（不带工具，响应快）
- `/api/clarify` — LLM 实时分析需求，生成澄清问题
- `/api/generate` — 代码生成（带工具）
- `[READY_TO_BUILD]` 信号 — Agent 准备好构建时输出

### 2.6 前端组件（app.js）

- `addMarkdownMessage()` — Markdown 渲染消息
- `addClarifyCard()` — 澄清问题卡片
- `addInlineButtons()` — 聊天框内按钮
- `startBuild()` — 触发代码生成
- `doDeploy()` — 部署到真机

---

## 三、已知问题

### 3.1 Agent 迭代效率低

**问题：** Agent 经常用完 20 次迭代都没完成。
**原因：** 
- verify_render 和 run_hardware 每次都运行，消耗迭代
- Agent 可能陷入"修复→验证→失败→修复"循环
- 系统提示没有明确优先级

**建议优化：**
- 增加迭代次数到 30
- 或者减少不必要的验证（只在 done 时验证）
- 或者让 Agent 更聪明地决定何时验证

### 3.2 系统提示不完整

**问题：** Agent 不知道所有验证规则。
**已修复：** 
- 添加了 `available_apis` 要求
- 添加了 `hardware-result.json` 要求

**可能遗漏：**
- 其他 server.mjs 中的验证规则
- 市场应用的特殊要求

**建议：** 把 server.mjs 中所有验证规则提取到一个常量，注入系统提示。

### 3.3 verify_render 不稳定

**问题：** Playwright 截图有时超时或失败。
**原因：** 
- WSL 环境下 Chromium 可能有问题
- 临时目录清理可能失败

**建议：** 
- 增加超时时间
- 添加 fallback（无 Chromium 时跳过截图）

### 3.4 硬件工具无硬件时行为

**问题：** 没有硬件连接时，ssh_exec/deploy_to_device 会失败。
**当前行为：** 返回错误信息 "硬件未配置"
**建议：** 
- 在系统提示中说明"无硬件时跳过硬件工具"
- 或者添加模拟模式

### 3.5 LESSONS.md 重复记录

**问题：** 每次构建都会追加经验，可能重复。
**建议：** 
- 去重（相同内容不重复记录）
- 或者限制最大条目数

---

## 四、关键架构决策

### 4.1 工具注册

所有工具定义在 `AGENT_TOOLS` 数组（OpenAI function calling 格式）。
工具实现在 `createToolExecutor()` 函数中。

**添加新工具步骤：**
1. 在 `AGENT_TOOLS` 添加定义
2. 在 `createToolExecutor` 的 switch 中添加实现
3. 更新系统提示说明工具用途

### 4.2 硬件接口注入

`createToolExecutor(fileStore, hardware)` 接受 hardware 参数：
```javascript
hardware = { ssh, scp, board }
```
- `ssh(command)` — 执行远程命令
- `scp(localFile, remoteDir)` — 复制文件到设备
- `board` — 设备配置对象

server.mjs 中传入：`{ ssh, scp, board: BOARD }`

### 4.3 经验记录流程

```
Agent 调用 record_lesson(type, content, context)
  ↓
写入 sessionLessons[] 数组（内存）
写入 LESSONS.md（项目文件）
  ↓
done 时合并到 experienceStore（SQLite）
  ↓
下次构建时 get_learnings 查询
```

### 4.4 自动验证循环

```javascript
// 在 runAgent 中
if (fnName === "done") {
  const verifyResult = await autoVerify(fileStore, executeTool, actions, onAction);
  if (!verifyResult.ok) {
    verificationAttempts++;
    // 注入错误信息，继续循环
    messages.push({ role: "user", content: `## ⚠️ 自动验证发现问题...` });
    continue; // 不返回，继续循环
  }
  // 验证通过，记录经验并返回
}
```

---

## 五、文件结构

```
vibeboard-linux-prototype/
├── server.mjs              # 后端主文件（3000+ 行）
├── app.js                  # 前端逻辑（1700+ 行）
├── index.html              # 前端页面
├── styles.css              # 样式
├── package.json            # 依赖（playwright, sql.js）
├── vibeboard.db            # SQLite 数据库
├── src/
│   ├── agent.mjs           # Agent 核心（工具定义 + 循环）
│   ├── memoryStore.mjs     # 用户偏好记忆
│   ├── experienceStore.mjs # 经验记忆
│   ├── clarifyEngine.mjs   # 需求澄清引擎
│   ├── conversationStore.mjs # 对话存储
│   ├── marketCatalog.mjs   # 市场应用目录
│   └── modelSettings.mjs   # 模型配置
├── generated/
│   └── current/            # 当前生成的应用
│       ├── index.html
│       ├── style.css
│       ├── app.js
│       ├── hardware_app.py
│       ├── LESSONS.md      # Agent 自动生成的经验
│       └── manifest.json
└── market-apps/            # 预设市场应用
```

---

## 六、API 端点

| 端点 | 方法 | 功能 |
|------|------|------|
| `/api/chat` | POST | 纯对话（不带工具） |
| `/api/clarify` | POST | 需求澄清 |
| `/api/generate` | POST | 代码生成（带工具） |
| `/api/preferences` | GET/POST/DELETE | 用户偏好 |
| `/api/experience` | GET | 经验查询 |
| `/api/status` | GET | 系统状态 |

---

## 七、优化建议（优先级排序）

### P0 — 必须修复

1. **提高迭代效率**
   - 减少不必要的验证调用
   - 或增加迭代次数到 30
   - 或让 Agent 更智能地决定验证时机

2. **完善系统提示**
   - 从 server.mjs 提取所有验证规则
   - 注入到系统提示中
   - 避免 Agent 生成不符合规范的代码

### P1 — 重要优化

3. **verify_render 稳定性**
   - 增加超时时间
   - 添加 Chromium 检测
   - 无 Chromium 时降级为语法检查

4. **经验去重**
   - record_lesson 时检查是否已存在相同内容
   - 避免 LESSONS.md 膨胀

5. **硬件模拟模式**
   - 无硬件时提供模拟数据
   - 让 Agent 能测试完整流程

### P2 — 锦上添花

6. **Agent 自我诊断**
   - 当迭代即将用完时，Agent 主动总结问题
   - 而不是默默失败

7. **经验可视化**
   - 前端展示经验统计
   - 成功率、常见陷阱等

8. **多模型支持**
   - 当前只支持 DeepSeek
   - 添加 OpenAI、Claude 等支持

---

## 八、测试命令

```bash
# 启动服务器
cd /mnt/c/tmp/vibeboard-linux-prototype
node server.mjs

# 测试 API
curl http://127.0.0.1:8789/api/status
curl http://127.0.0.1:8789/api/preferences
curl http://127.0.0.1:8789/api/experience?type=general

# 测试生成（需要 API Key）
curl -X POST http://127.0.0.1:8789/api/generate \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "创建一个计数器",
    "modelSettings": {
      "provider": "deepseek",
      "apiKey": "YOUR_API_KEY"
    }
  }'

# 语法检查
node --check server.mjs
node --check src/agent.mjs
node --check src/experienceStore.mjs
```

---

## 九、注意事项

1. **不要删除 generated/current/** — 这是当前运行的应用
2. **sql.js 是内存数据库** — 重启服务器会丢失数据（除非调用 saveDb）
3. **Playwright 需要 Chromium** — WSL 环境可能需要额外安装
4. **SSH 需要硬件连接** — 无硬件时跳过硬件工具
5. **API Key 安全** — 不要硬编码在代码中，从环境变量或配置读取

---

## 十、联系方式

- 项目路径：`/mnt/c/tmp/vibeboard-linux-prototype/`
- 服务器端口：8789
- 数据库：vibeboard.db（sql.js）
- 日志：`/tmp/vibeboard-server.log`

---

**祝 Codex 顺利！🚀**
