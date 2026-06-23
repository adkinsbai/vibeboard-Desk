# VibeBoard — AI 驱动的硬件应用生成平台

> 用自然语言描述你想要的应用，VibeBoard 自动生成代码、编译校验、并通过 SSH 部署到嵌入式设备（泰山派 RK3566）上运行。

![VibeBoard](https://img.shields.io/badge/Platform-Windows%20%2B%20WSL-blue) ![Node](https://img.shields.io/badge/Node.js-18%2B-green) ![License](https://img.shields.io/badge/License-MIT-yellow)

---

## 目录

- [项目简介](#项目简介)
- [最新更新](#最新更新)
- [系统架构](#系统架构)
- [核心功能](#核心功能)
- [快速开始](#快速开始)
- [项目结构](#项目结构)
- [API 参考](#api-参考)
- [硬件部署流程](#硬件部署流程)
- [应用市场](#应用市场)
- [调试经验与踩坑记录](#调试经验与踩坑记录)
- [已知限制](#已知限制)
- [License](#license)

---

## 项目简介

VibeBoard 是一个 **AI + 硬件** 的端到端应用生成平台。用户在 Web 界面中用中文描述想要的应用，系统会：

1. 调用 LLM（支持 OpenAI / Anthropic / 自定义 Provider）生成 480×360 的 Web 应用代码
2. 在本地进行语法校验和编译检查
3. 通过 SSH 将代码上传到泰山派开发板
4. 重启板端 Chromium Kiosk，应用立即在小屏上运行

整个流程从描述到真机运行，通常在 **30 秒内** 完成。

### 适用场景

- 快速原型验证：把想法变成真机上运行的应用
- 嵌入式 UI 开发：为小屏设备生成专用界面
- 教学演示：展示 AI 如何与硬件交互
- IoT 应用：天气、时钟、设备监控等桌面小应用

---

## 最新更新

当前版本把 VibeBoard 从单次生成 Demo 升级成了可持续工作的硬件应用工作台：

- **统一 Agent 生成链路**：聊天、需求澄清、项目记忆、代码生成、文件快照、L0-L3 本地验证和部署确认被串成同一个 Agent/Build Runtime 流程。
- **硬件契约前置**：每个 Generated App 必须包含 `index.html`、`style.css`、`app.js`、`hardware_app.py`、`manifest.json`，并通过 480×360 布局、相对资源、`hardware-result.json`、`/api/status`、音频 API 等契约检查。
- **灰色版真机部署修复**：`taishan-gray` 默认使用 `linaro` 账号，支持默认 SSH key 或密码认证；Windows 下大包上传改为 stdin 通道，避免 `spawn ENAMETOOLONG`；Golden Loop 会同时检查 HTTP、静态文件、manifest、板端程序、服务和 kiosk 几何。
- **真实 L4 验证通过**：灰色版 build `vb-mqqmu8pt-d296c7` 已部署到 `taishan-gray`，`/api/verify?id=vb-mqqmu8pt-d296c7&deviceId=taishan-gray` 返回 `goldenLoop.ok: true`。
- **持久对话与项目快照**：刷新页面后会自动恢复最近对话、消息、项目文件和预览状态；没有内容时设备预览保持纯黑屏，避免空 iframe 白屏。
- **Agent 交互提速**：澄清问题改为 `quick_replies` 选择题，每轮最多追问一个关键问题；用户输入“开始吧”会直接进入构建，输入“帮我部署吧”会基于当前构建直接显示部署确认按钮。
- **会话级资产库**：聊天框支持上传多文件资产，后端会分析图片、视频、音频、HTML/CSS/JS 组件、文本、字体、数据文件；`.zip`、`.tar`、`.tgz`、`.gz` 资源包会在安全路径和大小限制内展开，并聚合成面向 480×360 小屏的产品设计简报。资产分析会提取调色板、组件结构、CTA 文案、数据字段、交互暗示、媒体计划和媒体画像；图片会识别尺寸/比例，音频会识别 WAV 时长/采样率，视频会识别轻量容器提示。设计简报还会推断 `product-intent`、`layout-plan` 和 `completion-gap`，帮助 Agent/Codex 用默认方案补齐素材用途、版式和缺失 CTA/视觉方向，减少反复追问。上传反馈和 Assets 状态 tooltip 会展示这些重点。合同允许的被动资源会复制到生成应用的 `assets/uploaded/` 并写入 `manifest.json`，随预览、会话快照、市场发布和部署一起流转。
- **Agent 实现模式选择**：聊天框右下角可切换“自研 Agent / Codex 硬件模式”。Codex 模式现在走独立 `codex-hardware-agent` 桥接层，被限制在 VibeBoard 480×360 硬件嵌入式 UI 设计、生成、验证和部署确认范围内；明显非硬件请求会被代码层 scope guard 拦截并转回小屏设计选择题，前端会显示 `mode_boundary`、`codex_bridge` 状态和拦截原因。确认构建时，后端会把原始需求包装成 Codex hardware execution package，把硬件边界、Assets 情报、禁止自动部署和本地验证要求一起送进生成器。
- **应用市场扩展**：内置静态市场应用、预览图、二进制资源资产、数据库发布/部署流程，支持从市场一键部署回硬件。
- **Digital Life Companion**：新增独立 `/digital-life.html` 页面和本地优先的 companion runtime，包含长期记忆、情绪/认知/自主性循环、presence、硬件/音频 API 和 UI smoke 测试。
- **验证栈升级**：`npm run check` 会扫描主程序、前端脚本、`src/*.mjs`、Digital Life 和测试文件；`npm run verify:all` 汇总 Agent、offline 和 Digital Life 验证。

### Agent 工作流

Agent 的目标不是自动把代码写进真机，而是把风险分成几个明确关口：

1. **理解/规划**：`/api/agent` 调用 chat planner，整理当前对话、项目记忆、目标和约束。
2. **选择题澄清**：信息不足时只问一个最高影响问题，并返回 2-4 个 `quick_replies` 按钮，用户可以直接点选推进。
3. **资产理解与嵌入**：上传资产会进入会话级 Asset Library。Agent 看到的是文件类型、大小、用途建议、文本/组件摘要、安全信号、调色板、组件结构、CTA 文案、数据字段、交互暗示、媒体计划、媒体画像、产品意图、布局建议、自动补全缺口和聚合产品设计简报，而不是不受控执行上传代码；`.zip`、`.tar`、`.tgz`、`.gz` 包会被解析为保留目录结构的素材清单，危险路径、超限文件和不支持的压缩方式会被拒绝。合同允许的图片、音频、字体、JSON/WebM 等被动资源会以 `./assets/uploaded/...` 路径提供给生成器并进入最终应用；HTML/CSS/JS 和不在硬件资产合同内的文本类文件仍作为设计参考，由 Agent 提炼成界面内容。
4. **实现模式**：用户可选择自研 Agent 或 Codex 硬件模式；两种模式都必须遵守硬件嵌入式边界。Codex 模式会通过 `codex-hardware-agent` 独立提示词、`codex_bridge` 元数据和代码层 scope guard 工作，只服务硬件小屏设计、生成、验证和明确部署确认。确认构建后，Codex 模式会生成硬件执行包，保留用户原始需求，同时追加 Assets 使用策略、合同文件要求、本地 L0-L3 验证要求和“部署前必须确认”的限制。
5. **确认构建**：需求完整后显示“我理解你要的是/我准备这样做”的确认卡；用户点按钮或输入“开始吧/按这个方案”都会进入构建。
6. **本地 L0-L3 验证**：生成文件、硬件契约、语法、模拟运行和 480×360 渲染先在本地通过。
7. **部署确认**：本地验证完成后才显示部署按钮；如果用户直接输入“帮我部署吧”，前端会检测当前构建并直接给出部署确认按钮，不再重复追问。
8. **真机 L4 Golden Loop**：点击部署后通过 SSH 写入板端，再检查 HTTP、manifest、服务、kiosk 几何和板端运行结果。

---

## 系统架构

```
┌──────────────────────────────────────────────────────┐
│                    用户浏览器                          │
│  ┌──────────┐  ┌───────────┐  ┌───────────────────┐  │
│  │ 侧边栏    │  │  聊天区    │  │  设备预览 (iframe) │  │
│  │ 对话列表  │  │  消息流    │  │  480×360 实时预览  │  │
│  └──────────┘  └───────────┘  └───────────────────┘  │
└─────────────────────┬────────────────────────────────┘
                      │ HTTP API
┌─────────────────────▼────────────────────────────────┐
│                   server.mjs (Node.js)                │
│                                                      │
│  ┌─────────┐  ┌──────────┐  ┌──────────┐  ┌───────┐ │
│  │ 对话管理 │  │  LLM 调用 │  │ 编译校验  │  │ SSH   │ │
│  │ SQLite  │  │  代码生成  │  │ 语法检查  │  │ 部署  │ │
│  └─────────┘  └──────────┘  └──────────┘  └───┬───┘ │
│                                               │      │
│  ┌─────────────────────────────────────────┐  │      │
│  │          应用市场 (Marketplace)          │  │      │
│  │   发布 / 浏览 / 一键部署                 │  │      │
│  └─────────────────────────────────────────┘  │      │
└───────────────────────────────────────────────┼──────┘
                                                │
                    ┌───────────────────────────▼──────┐
                    │      泰山派 RK3566 (目标设备)      │
                    │                                  │
                    │  Chromium Kiosk (480×360)         │
                    │  HTTP Server (:8765)              │
                    │  /home/linaro/workspace/          │
                    │    taishan-screen/static/         │
                    └──────────────────────────────────┘
```

### 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | 原生 HTML/CSS/JS，无框架依赖 |
| 后端 | Node.js (ESM)，原生 HTTP 模块 |
| 数据库 | SQLite (sql.js) — 对话、消息、市场应用 |
| LLM | OpenAI API / Anthropic / 自定义 Provider |
| 硬件通信 | sshpass + SSH (Paramiko 备选) |
| 内网穿透 | FRP (Fast Reverse Proxy) |

---

## 核心功能

### 1. AI 代码生成

- 输入自然语言描述，自动生成 5 个文件：`index.html`, `style.css`, `app.js`, `hardware_app.py`, `manifest.json`
- 支持 OpenAI、Anthropic、自定义 OpenAI 兼容 Provider
- 可配置温度、Token 上限、系统提示词
- LLM 不可用时自动回退到本地模板生成

### 2. 编译校验

- Node.js `--check` 语法验证
- 文件完整性检查
- 生成唯一 Build ID（格式：`vb-<timestamp>-<hash>`）

### 3. 真机部署

- SSH 上传代码到泰山派
- 自动重启 Chromium Kiosk
- 备份历史版本到 `backups/` 目录
- 部署前后状态验证

### 4. 应用市场

- 发布应用到内置市场
- 浏览、搜索、筛选应用
- 一键部署市场应用到设备
- 下载计数统计

### 5. 对话管理

- 多对话历史记录
- 切换对话自动恢复消息和部署按钮
- SQLite 持久化存储

### 6. 设备状态监控

- 实时显示板端 Wi-Fi、IP、温度、内存
- 通过 FRP 隧道获取板端状态
- PC 端 iframe 预览与板端同步

---

## 快速开始

### 环境要求

- **操作系统**: Windows 10/11 + WSL (Ubuntu)
- **Node.js**: 18+
- **目标设备**: 泰山派 RK3566（或其他支持 SSH 的 Linux 板子）
- **网络**: 板子通过 FRP 或局域网可达

### 安装

```bash
# 克隆仓库
git clone https://github.com/adkinsbai/vibeboard-Desk.git
cd vibeboard-Desk

# 安装依赖
npm install

# 启动服务
npm start
```

服务默认运行在 `http://127.0.0.1:8789/`

### 配置

通过环境变量配置：

```bash
# 设置板子密码（必须）
export VIBEBOARD_BOARD_PASSWORD="your-board-password"

# 可选：如果本机默认 SSH key 已授权到板子，可不设置密码
# 灰色版默认使用 linaro@150.158.146.192:6278

# 可选：覆盖灰色版路由
export VIBEBOARD_BOARD_USER="linaro"
export VIBEBOARD_BOARD_HOST="150.158.146.192"
export VIBEBOARD_BOARD_PORT="6278"

# 可选：自定义 LLM Provider
export VIBEBOARD_LLM_PROVIDER="openai"
export VIBEBOARD_LLM_MODEL="gpt-4o"
export VIBEBOARD_LLM_API_KEY="sk-..."
```

### 快速验证

```bash
# 检查语法
npm run check

# 测试 API
curl http://127.0.0.1:8789/api/status
```

---

## 项目结构

```
vibeboard/
├── server.mjs          # 后端主文件（2600+ 行）
│                       # - HTTP 服务器
│                       # - LLM 代码生成
│                       # - 编译校验
│                       # - SSH 部署管道
│                       # - 对话/消息 API
│                       # - 应用市场 API
│                       # - 板端状态代理
│
├── index.html          # 主页 HTML
├── styles.css          # 全局样式（深色主题）
├── app.js              # 前端主逻辑
│                       # - 对话管理
│                       # - 消息渲染
│                       # - 生成/构建/部署流程
│                       # - 模型配置面板
│
├── market.html         # 应用市场页面
│                       # - 应用列表/搜索/筛选
│                       # - 一键部署 + 进度条
│
├── package.json        # 项目配置
├── .gitignore          # Git 忽略规则
│
├── skills/             # Hermes Agent 技能文件
│   └── vibeboard-gray-deploy/
│       ├── SKILL.md    # 部署操作手册
│       └── references/
│           └── gray-board-runbook.md
│
└── README.md           # 本文件
```

### 运行时生成的目录（不提交到 Git）

```
generated/
├── current/            # 当前生成的应用文件
│   ├── index.html
│   ├── style.css
│   ├── app.js
│   ├── hardware_app.py
│   └── manifest.json
└── <build-id>/         # 历史构建存档

runtime/
└── start-kiosk.sh      # 板端 Kiosk 启动脚本
```

---

## API 参考

### 对话 API

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/conversations` | 获取所有对话列表 |
| `POST` | `/api/conversations` | 创建新对话 |
| `GET` | `/api/conversations/:id/messages` | 获取对话消息 |
| `POST` | `/api/conversations/:id/messages` | 添加消息 |
| `DELETE` | `/api/conversations/:id` | 删除对话 |

### 生成 API

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/generate` | AI 代码生成 |
| `POST` | `/api/build` | 编译校验 |
| `POST` | `/api/deploy` | 部署到板端 |

### 市场 API

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/market` | 获取市场应用列表 |
| `GET` | `/api/market/:id` | 获取单个应用详情 |
| `POST` | `/api/market/publish` | 发布应用到市场 |
| `POST` | `/api/market/:id/deploy` | 从市场部署应用 |

### 设备 API

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/status` | 获取板端状态（代理） |

---

## 硬件部署流程

### 目标设备：泰山派 RK3566

| 配置项 | 值 |
|--------|-----|
| SSH 用户 | `linaro` |
| SSH 端口 | FRP: `150.158.146.192:6278` |
| 应用目录 | `/home/linaro/workspace/taishan-screen/static/` |
| Kiosk URL | `http://127.0.0.1:8765/` |
| 屏幕分辨率 | 480×360 |
| 系统服务 | `taishan-screen.service` |

### 部署步骤

```
1. 生成代码  →  LLM 生成 5 个文件
2. 编译校验  →  Node.js --check 语法验证
3. SSH 上传  →  通过 sshpass 上传到板端
4. 写入文件  →  板端 base64 解码并写入
5. 重启服务  →  systemctl restart taishan-screen
6. 启动 Kiosk → Chromium --kiosk --window-size=480,360
7. 验证状态  →  检查 build_id 和 HTTP 状态
```

### 板端验证命令

```bash
# 检查 Kiosk 进程
pgrep -a chromium

# 检查 HTTP 服务
curl -fsS http://127.0.0.1:8765/api/status

# 检查 build_id
grep -o 'vb-[a-z0-9-]*' /home/linaro/workspace/taishan-screen/static/index.html | head -1

# 检查屏幕分辨率
DISPLAY=:0 xwininfo -root | grep -E 'Width|Height'

# 检查服务状态
systemctl is-active taishan-screen.service
```

---

## 应用市场

VibeBoard 内置了一个轻量级应用市场，支持：

- **发布应用**：在主界面生成应用后，点击「发布到市场」按钮
- **浏览应用**：访问 `/market.html` 查看所有已发布应用
- **搜索筛选**：按名称搜索，按热门/最新筛选
- **一键部署**：点击「部署到我的设备」，带进度条的部署体验

### 部署进度条

市场部署包含 4 个可视化步骤：

1. **写入代码文件** — 将应用代码写入 `generated/current/`
2. **编译构建** — 语法校验和文件完整性检查
3. **上传到设备** — 通过 SSH 传输到板端
4. **部署并重启服务** — 重启 Kiosk 和 HTTP 服务

---

## 调试经验与踩坑记录

这是在开发 VibeBoard 过程中积累的真实调试经验，包含多个棘手问题的完整排查过程。

### 🔥 问题 1：Deploy 500 错误 — Windows 命令行转义地狱

**现象**：`POST /api/deploy` 返回 500 错误，但本地直接执行 SSH 命令正常。

**根因**：Node.js 的 `child_process.exec()` 在 Windows 上会通过 `cmd.exe` 执行命令，而 `cmd.exe` 会对 `%`、`"`、`!` 等字符进行二次转义，导致传给 SSH 的远程命令被破坏。

**排查过程**：

1. 在 `deployCurrent()` 中添加 `console.log` 追踪实际执行的命令
2. 发现包含双引号的远程 shell 命令在 Windows `CreateProcess` 中被错误转义
3. 例如 `sshpass ... ssh user@host "echo 'hello'"` 中的双引号被吞掉

**解决方案**：

```javascript
// ❌ 错误：命令中的引号会被 Windows 转义
const cmd = `sshpass -p ${pass} ssh ${user}@${host} "echo 'hello'"`;

// ✅ 正确：使用 bash -s 通过 stdin 传递命令
const cmd = `sshpass -p ${pass} ssh ${user}@${host} bash -s`;
// 然后通过 stdin 写入实际命令
```

**关键修改**：`paramikoExecOnce()` 函数改为使用 `bash -s` 模式，所有远程命令通过 stdin 传递，完全绕过 Windows 命令行转义。

---

### 🔥 问题 2：Python 子进程 input 类型错误

**现象**：`uploadBundle()` 函数报 `TypeError: a bytes-like object is required, not 'str'`

**根因**：Python 的 `subprocess.run()` 在 `input` 参数中需要 bytes，但传入了 string。

**解决方案**：

```python
# ❌ 错误
subprocess.run([...], input="some string")

# ✅ 正确
subprocess.run([...], input="some string".encode())
```

---

### 🔥 问题 3：Windows % 变量扩展

**现象**：Python 脚本中的 `%s` 格式化字符串被 Windows `cmd.exe` 提前扩展。

**根因**：Windows `cmd.exe` 会将 `%s` 中的 `%s` 视为环境变量引用（`%s` → 空字符串）。

**排查过程**：

1. Python 脚本在 Linux 上正常，通过 Windows 的 `child_process` 调用时失败
2. 添加调试日志发现 `%s.tmp.%s` 被展开为空字符串
3. 定位到 Windows 的 `%` 变量扩展机制

**解决方案**：使用 base64 编码传输 Python 脚本和数据，完全避免特殊字符问题：

```javascript
// 将 Python 脚本和数据都 base64 编码
const scriptB64 = Buffer.from(pythonScript).toString('base64');
const dataB64 = Buffer.from(JSON.stringify(data)).toString('base64');

// 在 Python 中解码执行
const cmd = `python3 -c "import base64; exec(base64.b64decode('${scriptB64}').decode())"`;
```

---

### 🔥 问题 4：Electron 安装程序 icudtl.dat 缺失

**现象**：使用 Inno Setup 打包的 Electron 应用启动时崩溃，错误：`[ERROR:icu_util.cc(223)]`

**根因**：Electron 依赖 `icudtl.dat` 国际化数据文件，但 Inno Setup 的 `.iss` 文件没有显式包含它。

**解决方案**：在 `.iss` 文件的 `[Files]` 段中显式添加：

```ini
[Files]
Source: "{app}\icudtl.dat"; DestDir: "{app}"; Flags: ignoreversion
```

---

### 🔥 问题 5：Paramiko SSH 通过 FRP 认证失败

**现象**：Python Paramiko 库通过 FRP 隧道连接板端 SSH 时认证失败，但直接 `sshpass` 命令正常。

**根因**：FRP 隧道对 SSH 协议的交互式认证有兼容性问题，特别是键盘交互式认证（keyboard-interactive）模式。

**解决方案**：放弃 Paramiko，改用 `sshpass` 子进程方式：

```javascript
// 使用 sshpass + ssh 命令，而不是 Paramiko
const cmd = `sshpass -p ${password} ssh -o StrictHostKeyChecking=no -p ${port} ${user}@${host} bash -s`;
```

**教训**：在嵌入式 + FRP 场景下，简单的命令行工具比复杂的 SSH 库更可靠。

---

### 🔥 问题 6：Kiosk 右侧画面裁剪

**现象**：板端 Chromium Kiosk 显示的应用右侧被裁剪。

**排查过程**：

1. 检查 `xwininfo -root`：分辨率确实是 480×360
2. 检查 Chromium 启动参数：`--window-size=480,360` 正确
3. 检查生成的 HTML：发现使用了 `width: 100vw` 而不是固定 `480px`

**根因**：`100vw` 在 Chromium Kiosk 模式下可能包含滚动条宽度，导致实际宽度超过 480px。

**解决方案**：

```css
/* ❌ 错误：vw 单位在 Kiosk 模式下不可靠 */
html, body { width: 100vw; height: 100vh; }

/* ✅ 正确：使用固定像素值 */
html, body {
  width: 480px;
  height: 360px;
  overflow: hidden;
}
```

---

### 🔥 问题 7：Chromium 重启后不显示

**现象**：`systemctl restart taishan-screen` 后 Chromium 进程存在但屏幕无显示。

**根因**：`pkill chromium` 使用 SIGTERM 信号，Chromium 可能不会立即退出，导致新进程与旧进程冲突。

**解决方案**：

```bash
# ❌ 错误：SIGTERM 可能不够
pkill chromium

# ✅ 正确：强制杀死 + 等待
pkill -9 chromium-bin 2>/dev/null
pkill -9 chromium 2>/dev/null
sleep 1
# 然后启动新的 Kiosk
```

---

### 🔥 问题 8：对话切换后聊天内容清空

**现象**：在侧边栏切换不同对话时，聊天区内容全部消失。

**根因**：`selectConversation()` 函数的 `renderMessages()` 只渲染纯文本消息，不包含：
- 阶段进度卡片（Stage Cards）
- 部署按钮（Deploy Button）
- 文件预览

切换对话后这些交互元素丢失，用户感觉「内容被清空」。

**解决方案**：

```javascript
function renderMessages(messages) {
  // ... 渲染消息 ...

  // 恢复部署按钮：检查最后一条消息的 build_id
  let lastBuildId = null;
  messages.forEach(msg => {
    if (msg.build_id) lastBuildId = msg.build_id;
  });

  if (lastBuildId) {
    // 重新创建部署按钮
    addDeployButton(lastBuildId);
  }
}
```

同时增加：
- 加载中状态显示
- 空消息欢迎语
- busy 状态禁止切换

---

### 🔥 问题 9：市场部署无反馈

**现象**：在应用市场点击「部署到我的设备」后，界面没有任何反应，直到部署完成才弹出 alert。

**根因**：`deployApp()` 函数使用 `await fetch()` 同步等待，部署过程 15-30 秒期间没有任何视觉反馈。

**解决方案**：添加进度条遮罩层，按时间模拟 4 个步骤的进度：

```
写入代码 (0-2s) → 编译构建 (2-6s) → 上传到设备 (6-12s) → 部署重启 (12s+)
```

部署完成后自动标记所有步骤为 ✓ 或标记失败步骤为 ✕。

---

### 🔥 问题 10：LLM 生成代码中的相对路径问题

**现象**：生成的应用在板端正常，但 PC 端预览 iframe 加载失败。

**根因**：LLM 生成的 HTML 使用绝对路径 `/style.css`，在 PC 端会加载平台根目录的 CSS 而不是生成目录的。

**解决方案**：在系统提示词中明确要求使用相对路径：

```
生成的 HTML 中必须使用相对路径：
- ✅ ./style.css
- ✅ ./app.js
- ❌ /style.css
- ❌ /app.js
```

---

### 🔥 问题 11：SSH 连接在 FRP 下不稳定

**现象**：通过 FRP 隧道执行多个 SSH 命令时，后面的命令偶尔失败。

**根因**：FRP 对 SSH 连接的保活机制不如直连稳定，多个短连接容易被中断。

**解决方案**：

1. 减少 SSH 连接次数：将多个命令合并为一个脚本通过 stdin 传输
2. 使用 `bash -s` 模式：单次连接执行多条命令
3. 添加重试机制：关键操作失败后自动重试

---

### 🔥 问题 12：SQLite 数据库并发访问

**现象**：同时发多个请求时偶现 `SQLITE_BUSY` 错误。

**解决方案**：

```javascript
// 设置 WAL 模式和忙等待超时
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
```

---

## 已知限制

| 限制 | 说明 |
|------|------|
| 单用户 | 当前设计为单用户使用，不支持多用户并发 |
| Windows 依赖 | SSH 命令通过 Windows 的 `sshpass` 执行，需要 WSL 或 Git Bash |
| LLM 依赖 | 代码生成依赖外部 LLM API，离线时只能使用本地模板 |
| 固定分辨率 | 生成的应用固定为 480×360，不支持自适应布局 |
| 无认证 | 没有用户认证机制，任何人可以访问和操作 |
| 数据库 | 使用 SQLite 文件，不支持分布式部署 |

---

## 开发指南

### 添加新的 LLM Provider

在 `server.mjs` 的 `callLLM()` 函数中添加新的 API 调用逻辑：

```javascript
if (provider === 'my-provider') {
  const response = await fetch('https://api.my-provider.com/v1/chat', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: model,
      messages: systemMessages.concat(userMessages)
    })
  });
  // ... 处理响应
}
```

### 自定义板端配置

修改 `skills/vibeboard-gray-deploy/SKILL.md` 中的板端参数：

```yaml
Board id: my-board
SSH user: my-user
SSH port: my-port
App root: /path/to/my/app
Screen size: 800x480
```

### 运行测试

```bash
# 语法检查
npm run check

# 启动开发服务器
npm start

# 查看日志
tail -f server.log
```

---

## License

MIT License. See [LICENSE](LICENSE) for details.

---

## 致谢

- **泰山派** — 提供 RK3566 开发板硬件支持
- **OpenAI / Anthropic** — LLM API 服务
- **FRP** — 内网穿透工具
- **Hermes Agent** — AI 辅助开发工具

---

*VibeBoard — 让 AI 成为你的硬件应用开发者。*
