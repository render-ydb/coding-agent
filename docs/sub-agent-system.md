# Sub-Agent 系统

## 概述

Sub-Agent 系统允许主 Agent 派生独立的子 Agent 来处理特定任务。每个子 Agent 拥有独立的对话上下文、专用的系统提示和受限的工具集，执行完毕后将文本结果返回给父 Agent。

这解决了单一对话循环的局限性：当任务可分解为独立子任务时，子 Agent 可以在隔离环境中专注执行，避免污染主对话的上下文窗口。

## 架构

```
┌──────────────────────────────────────────────────┐
│  父 Agent (主对话)                                │
│                                                  │
│  用户: "搜索所有 TODO 并整理成列表"                  │
│  模型 → tool_use: agent                           │
│         type: "explore"                           │
│         prompt: "搜索项目中所有 TODO 注释..."        │
│                                                  │
│  ┌────────────────────────────────────────┐       │
│  │  子 Agent (独立上下文)                   │       │
│  │                                        │       │
│  │  系统提示: EXPLORE_PROMPT              │       │
│  │  工具集: [read_file, list_files,       │       │
│  │          grep_search]                  │       │
│  │                                        │       │
│  │  独立执行 Agent Loop:                   │       │
│  │  grep_search → read_file → 生成结果    │       │
│  │                                        │       │
│  │  输出 → outputBuffer (不打印到 stdout) │       │
│  └──────────────┬─────────────────────────┘       │
│                 │                                 │
│  tool_result ← join(outputBuffer)                 │
│  token 用量 ← 累加到父 Agent                       │
│                                                  │
│  模型继续处理子 Agent 的结果...                      │
└──────────────────────────────────────────────────┘
```

## 三种内置类型

| 类型 | 工具集 | 适用场景 |
|------|-------|---------|
| `explore` | read_file, list_files, grep_search | 快速搜索定位代码、文件、符号 |
| `plan` | read_file, list_files, grep_search | 结构化分析、方案设计、架构决策 |
| `general` | 所有工具（排除 agent） | 通用任务执行，包括文件编辑和命令运行 |

## 关键文件

| 文件 | 职责 |
|------|------|
| `src/subagent.ts` | 子 Agent 配置：类型定义、系统提示、工具集过滤 |
| `src/tools/builtin/agent.ts` | agent 工具的 schema 定义（参数格式、描述） |
| `src/agent.ts` | 核心执行逻辑：executeAgentTool、runOnce、emitText |

## 数据流

### 1. 工具调用路由

模型返回 `tool_use: agent` 时，`chat()` 中的工具执行循环按以下优先级路由：

```
earlyExecution（流式提前执行）
  → plan mode 工具（enter/exit_plan_mode）
  → agent 工具 ← 在此拦截
  → MCP 工具
  → 权限检查 → executeTool()
```

agent 工具在 `agent.ts` 内部拦截处理（而非走 `executeTool` 路由），原因是：
- 子 Agent 需要访问父 Agent 的 `client`、`model` 等内部状态
- 在 `tools/` 模块中实现会产生 `tools/ → agent.ts → tools/` 的循环依赖

### 2. 子 Agent 生命周期

```
父 Agent.executeAgentTool(input)
  │
  ├─ getSubAgentConfig(type)        // 获取系统提示 + 工具集
  │
  ├─ new Agent({                    // 创建独立实例
  │     isSubAgent: true,
  │     customSystemPrompt: ...,
  │     customTools: ...,
  │     permissionMode: "bypassPermissions"
  │   })
  │
  ├─ subAgent.runOnce(prompt)       // 执行
  │     ├─ outputBuffer = []        // 设置文本捕获
  │     ├─ chat(prompt)             // 完整 Agent Loop
  │     │    ├─ 跳过 MCP 初始化
  │     │    ├─ 跳过 memory prefetch
  │     │    ├─ 跳过 spinner
  │     │    ├─ 跳过 autoSave
  │     │    └─ emitText → push to outputBuffer
  │     └─ return { text, tokens }
  │
  ├─ 累加 token 用量到父 Agent
  │
  └─ return text（作为 tool_result）
```

### 3. 文本输出路由

```
emitText(text)
  ├─ outputBuffer !== null → outputBuffer.push(text)  // 子 Agent：缓冲
  └─ outputBuffer === null → printAssistantText(text)  // 父 Agent：stdout
```

所有文本输出点（流式文本、思考内容、换行符）都通过 `emitText()` 统一路由，确保子 Agent 的输出被完整捕获而非直接打印。

## 子 Agent 的行为差异

子 Agent（`isSubAgent = true`）与父 Agent 的行为差异：

| 行为 | 父 Agent | 子 Agent | 原因 |
|------|---------|---------|------|
| MCP 初始化 | 首次 chat 时执行 | 跳过 | 使用父 Agent 传入的 customTools |
| Memory prefetch | 每轮用户输入触发 | 跳过 | 短暂任务不需要独立记忆召回 |
| Spinner | 显示 | 跳过 | 避免与父 Agent 的终端输出冲突 |
| autoSave | 每轮 chat 后保存 | 跳过 | 短暂会话无需持久化 |
| 文本输出 | stdout | outputBuffer | 由 runOnce() 收集后返回给父 Agent |
| 工具集 | toolDefinitions + MCP | customTools | 按类型限制，且排除 agent 工具 |
| 系统提示 | buildSystemPrompt + memory | customSystemPrompt | 简洁聚焦的角色定义 |

## 递归防护

子 Agent 的工具集中**不包含 `agent` 工具**：

- `explore` / `plan` 类型：工具集仅包含 3 个只读工具，天然排除 agent
- `general` 类型：`getGeneralTools()` 显式过滤 `t.name !== 'agent'`

这保证了子 Agent 无法再次调用 agent 工具派生"孙 Agent"，防止无限递归。

## 权限模式

子 Agent 的权限模式由父 Agent 决定：

```typescript
permissionMode: this.permissionMode === 'plan' 
  ? 'plan'              // 父 Agent 在 plan 模式 → 子 Agent 也只读
  : 'bypassPermissions'  // 其他模式 → 子 Agent 自动批准所有操作
```

子 Agent 使用 `bypassPermissions` 的理由：
- 子 Agent 是受控环境，工具集已经被限制
- 子 Agent 无法与用户交互（没有 readline/confirmFn）
- 频繁确认会打断子 Agent 的自主执行流程

## Token 计费

子 Agent 的 token 用量**累加到父 Agent**的统计中：

```typescript
const result = await subAgent.runOnce(prompt);
this.totalInputTokens += result.tokens.input;
this.totalOutputTokens += result.tokens.output;
```

`runOnce()` 通过记录调用前后的 token 差值来计算增量，确保父 Agent 的 `/cost` 命令能反映包括子 Agent 在内的真实总用量。

## 工具定义 Schema

```json
{
  "name": "agent",
  "description": "Launch a sub-agent to handle a task autonomously...",
  "input_schema": {
    "type": "object",
    "properties": {
      "description": {
        "type": "string",
        "description": "Short (3-5 word) description of the sub-agent's task"
      },
      "prompt": {
        "type": "string",
        "description": "Detailed task instructions for the sub-agent"
      },
      "type": {
        "type": "string",
        "enum": ["explore", "plan", "general"],
        "description": "Agent type. Default: general"
      }
    },
    "required": ["description", "prompt"]
  }
}
```

## 使用示例

模型在处理复杂任务时可能这样调用：

```
用户: "帮我重构 src/utils/ 下的所有工具函数，统一导出方式"

模型思考: 这个任务需要先了解现有结构，再做修改。用 explore 子 Agent 先搜索。

→ tool_use: agent
  type: "explore"
  description: "搜索 utils 导出方式"
  prompt: "在 src/utils/ 下搜索所有文件，分析每个文件的导出方式（default export vs named export），
           列出文件路径和当前导出方式。"

← tool_result: "找到 8 个文件：
  - src/utils/format.ts: named exports (formatDate, formatNumber)
  - src/utils/validate.ts: default export (class Validator)
  ..."

模型: 基于搜索结果，开始逐个文件重构...
```
