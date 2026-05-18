# OpenAI 兼容后端

## 概述

Agent 支持双后端架构：Anthropic Messages API 和 OpenAI Chat Completions API。通过 `backend` 配置项切换，支持 OpenAI、Ollama、vLLM 等 OpenAI 兼容服务。

## 架构设计

```
┌──────────┐     ┌──────────────┐     ┌──────────────────┐
│  用户    │ ──> │   Agent      │ ──> │ Anthropic API    │
│  (CLI)   │ <── │   (路由层)   │ ──> │ 或 OpenAI API    │
└──────────┘     └──────┬───────┘     └──────────────────┘
                        │
              ┌─────────┼─────────┐
              │         │         │
         chatAnthropic  │    chatOpenAI
              │         │         │
         callApi    共享逻辑   callOpenAIStream
              │         │         │
              └─────────┼─────────┘
                        │
                  ┌─────▼──────┐
                  │  工具执行   │
                  │(共享路径)   │
                  └────────────┘
```

## 配置方式

### 环境变量

```bash
# .env

# Anthropic 后端（默认）
API_KEY=sk-ant-xxx
API_BASE_URL=https://api.anthropic.com/v1
MODEL=claude-sonnet-4-6

# OpenAI 后端
BACKEND=openai
API_KEY=sk-xxx
API_BASE_URL=https://api.openai.com/v1
MODEL=gpt-4o

# Ollama（自动检测为 openai）
API_BASE_URL=http://localhost:11434/v1
MODEL=llama3
```

### 自动检测逻辑

当未设置 `BACKEND` 环境变量时，通过启发式规则推断：

| 条件 | 判定结果 |
|------|----------|
| URL 含 `anthropic` 或 MODEL 含 `claude` | anthropic |
| URL 含 `openai.com` / `ollama` / `vllm` | openai |
| MODEL 以 `gpt-` / `o1` / `o3` 开头 | openai |
| 其他 | anthropic（向后兼容） |

## 核心实现

### 关键文件

- `src/agent.ts` — Agent 类，双后端路由和实现
- `src/index.ts` — CLI 入口，后端检测配置
- `src/session.ts` — 会话持久化，双格式支持

### 消息格式差异

| 特性 | Anthropic | OpenAI |
|------|-----------|--------|
| System prompt | 独立 `system` 参数 | `messages[0]` 中 `role: "system"` |
| 工具结果 | `user` 消息中的 `tool_result` block | 独立 `role: "tool"` 消息 |
| 消息交替 | 严格 user → assistant 交替 | 无严格要求 |
| 流式工具执行 | `content_block_stop` 事件触发提前执行 | 不支持，改用 Phase 1/2 模式 |

### Agent 类字段布局

```typescript
class Agent {
  // 后端选择
  private useOpenAI: boolean;
  private client!: Anthropic;         // Anthropic 模式
  private openaiClient?: OpenAI;      // OpenAI 模式

  // 双消息历史（互斥使用）
  private anthropicMessages: Anthropic.MessageParam[] = [];
  private openaiMessages: OpenAI.ChatCompletionMessageParam[] = [];
  // ...
}
```

### chat() 路由

```typescript
async chat(userMessage: string): Promise<void> {
  // MCP 初始化（共享）
  // ...
  if (this.useOpenAI) {
    await this.chatOpenAI(userMessage);
  } else {
    await this.chatAnthropic(userMessage);
  }
  // finally: 清理 + autoSave（共享）
}
```

### OpenAI 工具执行模式（Phase 1/2）

由于 OpenAI 流式响应没有 `content_block_stop` 事件，无法像 Anthropic 那样在流式阶段提前执行工具。改用两阶段模式：

**Phase 1（串行）**：遍历所有 tool_calls，执行权限检查和用户确认。内部工具（plan_mode、agent、skill、MCP）跳过权限检查。

**Phase 2（分批）**：将已通过权限的工具按并发安全性分批：
- 连续的并发安全工具 → `Promise.all()` 并行执行
- 非安全工具 → 串行执行

```typescript
// Phase 1: 串行权限检查
for (const tc of toolCalls) {
  const perm = checkPermission(name, input, ...);
  checkedCalls.push({ tc, name, input, allowed: ... });
}

// Phase 2: 分批执行
for (const batch of batches) {
  if (batch.concurrent) {
    await Promise.all(batch.items.map(cc => executeToolForOpenAI(...)));
  } else {
    for (const cc of batch.items) { await executeToolForOpenAI(...); }
  }
}
```

### 工具格式转换

Anthropic 的工具定义作为规范格式（canonical），OpenAI 格式在每次 API 调用前动态转换：

```typescript
function toOpenAITools(tools: Anthropic.Tool[]): OpenAI.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.input_schema as Record<string, unknown>,
    },
  }));
}
```

### 内部工具统一路由

MCP、plan mode、agent、skill 工具的执行逻辑抽取为共享方法，两个后端都走同一条路径：

```typescript
// 判断是否为内部工具
private isInternalTool(name: string): boolean {
  return name === 'enter_plan_mode' || name === 'exit_plan_mode' ||
    name === 'agent' || name === 'skill' ||
    this.mcpManager.isMcpTool(name);
}

// 执行内部工具（返回 null 表示非内部工具）
private async executeInternalTool(name, input): Promise<string | null> { ... }

// OpenAI 完整路由：内部工具 → 常规工具
private async executeToolForOpenAI(name, input): Promise<string> {
  const internal = await this.executeInternalTool(name, input);
  if (internal !== null) return internal;
  return executeTool(name, input, this.readFileState);
}
```

### 压缩管道

每个后端有独立的 3 层压缩方法，由 `runCompressionPipeline()` 统一路由：

| Tier | Anthropic 方法 | OpenAI 方法 | 操作对象 |
|------|---------------|-------------|----------|
| 1 | `budgetToolResults()` | `budgetToolResultsOpenAI()` | 截断大结果 |
| 2 | `snipStaleResults()` | `snipStaleResultsOpenAI()` | 替换旧结果为占位符 |
| 3 | `microcompact()` | `microcompactOpenAI()` | 缓存冷却后激进清理 |
| 4 | `compactAnthropic()` | `compactOpenAI()` | API 调用做摘要压缩 |

OpenAI 压缩操作 `role: "tool"` 消息（独立消息），Anthropic 操作 `user` 消息内的 `tool_result` block。

### 会话持久化

```typescript
interface SessionData {
  metadata: SessionMetadata;
  messages?: any[];          // Anthropic 格式
  openaiMessages?: any[];   // OpenAI 格式
}
```

两字段互斥，恢复时根据哪个有值决定目标数组。不同后端创建的会话不能跨后端恢复（格式不兼容）。

### 子 Agent 传播

子 Agent 创建时继承父 Agent 的 `backend` 配置：

```typescript
const subAgent = new Agent({
  apiKey: this.useOpenAI ? openaiClient.apiKey : client.apiKey,
  apiBaseUrl: this.useOpenAI ? openaiClient.baseURL : client.baseURL,
  backend: this.useOpenAI ? 'openai' : 'anthropic',
  // ...
});
```

## 功能对比

| 功能 | Anthropic 后端 | OpenAI 后端 |
|------|---------------|-------------|
| 流式文本输出 | ✅ | ✅ |
| 工具调用 | ✅ | ✅ |
| 流式工具提前执行 | ✅ (content_block_stop) | ❌ (用 Phase 1/2 替代) |
| Extended Thinking | ✅ | ❌ (模型不支持) |
| 多层压缩管道 | ✅ | ✅ |
| 对话摘要压缩 | ✅ | ✅ |
| Memory 语义召回 | ✅ | ✅ |
| MCP 工具 | ✅ | ✅ |
| Sub-Agent | ✅ | ✅ |
| Skill (fork/inline) | ✅ | ✅ |
| Plan Mode | ✅ | ✅ |
| Session 持久化 | ✅ | ✅ |
| 预算控制 | ✅ | ✅ |

## 限制

1. **Extended Thinking** 仅 Claude 4.x 支持，OpenAI 模式下自动禁用
2. **流式工具提前执行** 依赖 Anthropic 的 `content_block_stop` 事件，OpenAI 无此机制
3. **会话不可跨后端恢复** — Anthropic 和 OpenAI 的消息格式不兼容
4. **Token 费率估算** 使用固定费率（$3/M input, $15/M output），不同模型实际费率可能不同
