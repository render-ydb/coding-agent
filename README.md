# Coding Agent

从零实现的最小可用 AI 编程助手 CLI，使用 TypeScript 构建。

实现了经典的 **Tool-Use Agent Loop**：用户输入 → LLM 决策 → 调用工具 → 执行工具 → 返回结果 → 循环直到完成。

```
┌──────────┐     ┌──────────┐     ┌──────────┐
│  用户    │ ──> │  Agent   │ ──> │ Anthropic│
│  (CLI)   │ <── │  Loop    │ <── │  API     │
└──────────┘     └────┬─────┘     └──────────┘
                      │
                 ┌────▼─────┐
                 │  Tools   │
                 └──────────┘
```

## 快速开始

```bash
# 安装依赖
npm install

# 配置环境变量
cp .env.example .env
# 编辑 .env，填入 API Key、Base URL 和模型名称

# 开发模式运行
npm run dev

# 或者构建后运行
npm run build && npm start
```

## 已实现功能

### 核心引擎

| 功能 | 说明 | 代码位置 |
|------|------|---------|
| Tool-Use Agent Loop | 用户输入 → LLM → tool_use → 执行 → tool_result → 循环 | `src/agent.ts` `chat()` |
| 流式响应 | 通过 Anthropic Streaming API 实时输出文本 | `src/agent.ts` `callApi()` |
| 中断支持 | Ctrl+C 通过 AbortController 中断正在进行的 API 请求 | `src/agent.ts` `abort()` |
| 预算控制 | 支持最大花费（美元）和最大轮次限制，超出自动停止 | `src/agent.ts` `isBudgetExceeded()` |
| Token 统计 | 累计输入/输出 token 计数和费用估算 | `src/agent.ts` `getTokenUsage()` |
| Extended Thinking | 模型内部推理链，支持 adaptive/enabled 两种模式 | `src/agent.ts` `callApi()` |
| 流式工具并发执行 | tool_use block 流式完成时立即启动只读工具，与后续 block 传输并行 | `src/agent.ts` `callApi()` |

### 工具系统

| 工具 | 功能 | 代码位置 |
|------|------|---------|
| `read_file` | 读取文件内容，支持指定行范围 | `src/tools/builtin/read-file.ts` |
| `write_file` | 创建或覆写文件 | `src/tools/builtin/write-file.ts` |
| `edit_file` | 精确字符串替换编辑 | `src/tools/builtin/edit-file.ts` |
| `list_files` | 递归列出目录内容 | `src/tools/builtin/list-files.ts` |
| `grep_search` | 正则表达式跨文件搜索 | `src/tools/builtin/grep-search.ts` |
| `run_shell` | 执行 shell 命令，支持超时控制 | `src/tools/builtin/run-shell.ts` |

### 权限系统

| 模式 | 启动参数 | 行为 |
|------|---------|------|
| `default` | *(无)* | 危险命令和新文件写入需要用户确认 |
| `bypassPermissions` | `--yolo` / `-y` | 跳过所有确认提示 |
| `acceptEdits` | `--accept-edits` | 自动批准文件编辑，危险 shell 命令仍需确认 |
| `plan` | `--plan` | 规划模式：只读 + 写 plan 文件，支持交互式审批后执行 |
| `dontAsk` | `--dont-ask` | 自动拒绝所有需要确认的操作（CI 模式） |

危险命令检测覆盖：`rm`、`git push/reset/clean`、`sudo`、`mkfs`、`dd`、`kill`、`reboot`、`shutdown`，以及 Windows 等价命令（`del`、`rmdir`、`format`、`taskkill`、`Remove-Item`、`Stop-Process`）。

### Plan Mode（规划模式）

让 Agent 在修改代码之前先制定方案，用户审批通过后再执行。核心理念：**先想清楚再动手**。

**三种进入方式：**

```bash
# 1. CLI 参数启动
coding-agent --plan "重构 auth 模块"

# 2. REPL 中切换
> /plan                    # 进入 plan 模式
> 帮我优化数据库查询
> ...模型读代码、写计划...
> /plan                    # 退出 plan 模式

# 3. 模型自主调用 enter_plan_mode 工具
```

**生命周期：**

```
进入 Plan Mode → 只读探索代码 → 写 plan 文件 → exit_plan_mode → 用户审批 → 执行
                                                        ↑                    │
                                                        └── 反馈修改 ←────────┘
```

**审批选项（模型调用 `exit_plan_mode` 后触发）：**

| 选项 | 行为 |
|------|------|
| 1. 清空上下文并执行 | 清空历史消息，以 plan 为起点开始执行，自动批准编辑 |
| 2. 保留上下文并执行 | 保持对话连贯，自动批准编辑 |
| 3. 手动审批每个编辑 | 保持对话连贯，每个文件修改需用户确认 |
| 4. 继续规划 | 提供反馈文本，模型修改 plan 后再次提交 |

**Plan 文件存储位置：** `~/.coding-agent/plans/plan-{sessionId}.md`

详细设计文档见 [docs/plan-mode.md](docs/plan-mode.md)。

### Memory 语义召回（跨会话记忆）

文件级持久化记忆系统，每轮用户输入时异步预取相关记忆，通过 sideQuery LLM 调用语义选择，非阻塞注入到对话上下文。

**记忆类型：**

| 类型 | 用途 | 示例 |
|------|------|------|
| `user` | 用户角色、偏好、知识水平 | "用户是后端工程师，熟悉 Go" |
| `feedback` | 用户纠正和指导 | "测试不要 mock，用真数据库" |
| `project` | 进行中的工作、目标、截止日期 | "3/5 后代码冻结" |
| `reference` | 外部资源指针 | "bug 追踪在 Linear INGEST 项目" |

**存储位置：** `~/.coding-agent/projects/{sha256-hash}/memory/`（按工作目录隔离）

**语义召回流程：**

```
用户输入 → 三重门控检查 → 异步 sideQuery（后台 LLM，256 tokens）
                              ↓
              scanMemoryHeaders（仅读 frontmatter）
              → formatMemoryManifest → 模型选择 ≤5 条
              → 读取完整内容 → 注入到 user 消息
```

**三重门控（任一不通过则跳过召回）：**

| 门控 | 条件 | 原因 |
|------|------|------|
| 输入实质性 | 2+ CJK 字符 或 多词 | 单词指令（"hi"、"/clear"）无语义上下文 |
| 会话预算 | 累计注入 < 60KB | 防止记忆挤占工具调用空间 |
| 记忆存在 | 磁盘上有 .md 文件 | 首次使用时零开销 |

**预算限制：**

| 层级 | 限制 | 说明 |
|------|------|------|
| 单文件 | 4 KB | 注入时截断 |
| 单次选择 | 5 条 | sideQuery 最多选 5 条 |
| 会话总量 | 60 KB | 超出后停止预取 |
| 文件数量 | 200 个 | 扫描上限 |

```bash
# 查看当前记忆
> /memory

  Memories (2):
    [user] 用户角色 — 高级后端工程师，熟悉 Go 和 K8s
    [feedback] 测试规范 — 不要用 mock，必须用真数据库
```

详细设计文档见 [docs/memory-system.md](docs/memory-system.md)。

### 上下文管理（5 层递进压缩管道）

| 层级 | 名称 | 触发条件 | 策略 | API 开销 |
|------|------|---------|------|---------|
| Tier 0 | 大结果持久化 | 单条结果 > 30KB | 写入磁盘，上下文仅保留 200 行预览 | 0 |
| Tier 1 | 预算截断 | 上下文利用率 > 50% | 保留结果头部 + 尾部，裁剪中间 | 0 |
| Tier 2 | 过期结果 Snip | 上下文利用率 > 60% | 旧的/重复的工具结果替换为占位符 | 0 |
| Tier 3 | 微压缩 | 空闲 > 5 分钟 | 激进清理所有旧结果（prompt cache 已过期） | 0 |
| Tier 4 | 自动摘要压缩 | 上下文利用率 > 85% | 通过一次 API 调用将整个对话压缩为摘要 | 1 次 API |

详细设计文档见 [docs/context-management-design.md](docs/context-management-design.md)。

### Extended Thinking（扩展思考）

通过 `--thinking` 启用，让模型在生成最终回答前先进行内部推理。

| 特性 | 说明 |
|------|------|
| 模型检测 | 自动识别 Claude 4.x 系列，非 Claude 模型静默降级为禁用 |
| 思考模式 | **adaptive**（4.6 系列，按问题复杂度自动调节深度）/ **enabled**（4.x 其他版本，始终思考） |
| 动态 max_tokens | Opus 4.6: 64K, Sonnet 4.6 / 其他 4.x: 32K, 未知模型: 16K |
| 流式输出 | 思考过程以灰色 dim 文字实时展示（`[thinking] ...`），与正常回答视觉区分 |
| 历史过滤 | thinking blocks 仅流式展示，不存入对话历史，避免占用上下文空间 |

```bash
# 启用扩展思考
coding-agent --thinking "分析这段代码的性能瓶颈"

# 配合其他参数使用
coding-agent --thinking --yolo "重构这个函数并解释你的推理过程"
```

### 流式工具并发执行（Streaming Tool Execution）

当模型在一次响应中返回多个 tool_use block 时（如同时读取 3 个文件），传统做法是等待流式响应**完全结束**后才开始逐个执行工具。流式并发执行改为：每当一个 tool_use block 在流式传输中完成，**立即启动**该工具的执行。

```
传统：  [流式响应完成] → 执行 tool A → 执行 tool B → 发送结果
并发：  [tool A 流完 → 立即执行] [tool B 流完 → 立即执行] [流式结束 → 收集结果(秒出)]
```

| 特性 | 说明 |
|------|------|
| 安全工具集 | `read_file`、`list_files`、`grep_search`（无副作用的纯读取操作） |
| 权限前置校验 | 回调中调用 `checkPermission`，仅 `action=allow` 时提前启动 |
| 流式追踪 | 通过 `toolBlocksByIndex` Map 逐步累积 `input_json_delta`，block 结束时解析完整 JSON |
| 结果消费 | 工具执行循环中通过 `earlyExecutions` Map 查找已启动的 Promise，命中则跳过常规权限检查 |
| 安全保障 | `run_shell` 不纳入、需确认的操作不提前执行、Plan 模式读操作正常工作 |

详细设计文档见 [docs/streaming-tool-execution.md](docs/streaming-tool-execution.md)。

### MCP 集成（外部工具扩展）

通过 MCP（Model Context Protocol）协议接入外部工具生态，让 Agent 能力不再局限于内置工具。

**配置方式：** 在项目根目录创建 `.mcp.json`，或在 `.claude/settings.json` 中添加 `mcpServers` 字段：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "ghp_xxx" }
    }
  }
}
```

| 特性 | 说明 |
|------|------|
| 协议 | JSON-RPC 2.0 over stdio，零 SDK 依赖 |
| 懒加载 | 首次 `chat()` 调用时才连接服务器 |
| 工具命名 | `mcp__<serverName>__<toolName>` 避免与内置工具冲突 |
| 优雅降级 | 单个服务器失败不影响其他服务器和内置工具 |
| 超时保护 | 初始化和工具发现均有 15 秒超时 |
| 权限控制 | Plan 模式下禁止调用 MCP 工具（只读保护） |
| 配置来源 | `~/.claude/settings.json` → `.claude/settings.json` → `.mcp.json`（优先级递增） |

```bash
# 启动后自动连接配置的 MCP 服务器
coding-agent
# 控制台显示：[mcp] Connected to 'github' — 12 tools
```

详细设计文档见 [docs/mcp.md](docs/mcp.md)。

### API 容错

| 功能 | 说明 |
|------|------|
| 指数退避重试 | 遇到 429/503/529/ECONNRESET/ETIMEDOUT 自动重试，带随机抖动 |
| 最多 3 次重试 | 超过重试次数后抛出原始错误 |
| 中断感知 | 用户 Ctrl+C 时立即终止重试循环 |
| 代理支持 | 兼容 Anthropic 官方 API 和任意兼容代理（litellm 等） |

### CLI 与 REPL

| 功能 | 说明 |
|------|------|
| 交互式 REPL | 基于 readline 的持久对话循环 |
| 单次模式 | 通过参数传入 prompt：`coding-agent "修复这个 bug"` |
| `/clear` | 清空对话历史 |
| `/plan` | 切换 Plan Mode（只读规划 ↔ 正常模式） |
| `/cost` | 显示 token 用量和估算费用 |
| `/compact` | 手动触发对话压缩 |
| `/memory` | 列出当前项目的所有记忆 |
| 双次 Ctrl+C | 第一次中断当前请求，第二次退出程序 |

### 命令行参数

```
--yolo, -y          跳过所有权限检查
--plan              只读规划模式
--accept-edits      自动批准文件编辑
--dont-ask          自动拒绝确认（CI 模式）
--thinking          启用扩展思考
--resume            恢复上次会话（开发中）
--max-cost <美元>    设定最大花费上限
--max-turns <次数>   设定最大工具执行轮次
--help, -h          显示帮助
--version, -v       显示版本
```

## 项目结构

```
coding-agent/
├── src/
│   ├── index.ts              # CLI 入口：参数解析、REPL 循环、.env 配置加载
│   ├── agent.ts              # 核心引擎：Agent Loop、流式响应、上下文压缩、记忆集成
│   ├── memory.ts             # 记忆系统：CRUD、语义召回、预取、系统提示
│   ├── frontmatter.ts        # YAML frontmatter 解析器（被 memory.ts 依赖）
│   ├── session.ts            # 会话持久化：save/load/list
│   ├── mcp.ts                # MCP 客户端：JSON-RPC over stdio，工具发现和路由
│   ├── ui.ts                 # 终端输出：spinner、工具展示、plan 审批 UI
│   └── tools/
│       ├── index.ts           # 工具注册表和路由器
│       ├── types.ts           # ToolDefinition 接口定义
│       ├── permissions.ts     # 权限模式和危险命令检测
│       └── builtin/
│           ├── index.ts       # 注册所有内置工具
│           ├── read-file.ts   # 读取文件
│           ├── write-file.ts  # 写入文件
│           ├── edit-file.ts   # 编辑文件
│           ├── list-files.ts  # 列出文件
│           ├── grep-search.ts  # 搜索文件
│           ├── run-shell.ts    # 执行命令
│           └── plan-mode.ts    # Plan Mode 工具（enter/exit_plan_mode）
├── docs/
│   ├── memory-system.md              # Memory 语义召回设计文档
│   ├── context-management-design.md  # 上下文管理设计文档
│   ├── plan-mode.md                  # Plan Mode 设计文档
│   ├── mcp.md                        # MCP 集成设计文档
│   └── streaming-tool-execution.md   # 流式工具并发执行设计文档
├── package.json
├── tsconfig.json
└── .env                       # API_KEY, API_BASE_URL, MODEL
```

## 环境配置

在项目根目录创建 `.env` 文件：

```env
API_KEY=your-api-key
API_BASE_URL=https://your-api-endpoint/v1
MODEL=claude-sonnet-4-6
```

Agent 同时发送 `x-api-key` 和 `Authorization: Bearer` 请求头，兼容 Anthropic 官方 API 和 litellm 等代理网关。

## 技术栈

| 组件 | 选型 |
|------|------|
| 运行时 | Node.js |
| 语言 | TypeScript（严格模式） |
| LLM SDK | `@anthropic-ai/sdk` |
| 环境变量 | `dotenv` |
| 构建 | `tsc`（ESM 模块） |
| 开发 | `tsx`（免构建运行） |
