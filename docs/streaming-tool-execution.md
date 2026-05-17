# 流式工具并发执行（Streaming Tool Execution）

## 解决的问题

传统 Agent Loop 的工具执行是**串行阻塞**的：

```
API 流式返回 ──────────────────────────┐
  [text] [tool_use:A] [tool_use:B]     │ 等待全部 block 返回
                                       ▼
执行 tool A ─────┐
                 ▼
执行 tool B ─────┐
                 ▼
发送 tool_result 给 API
```

当模型在一次响应中返回多个 `tool_use` block（比如同时读取 3 个文件），
所有工具必须等到流式响应**完全结束**后才开始执行，造成不必要的等待。

流式工具并发执行的做法是：每当一个 `tool_use` block 在流式中传输完毕，
**立即启动执行**，与后续 block 的传输并行：

```
API 流式返回 ─────────────────────────────────┐
  [text] [tool_use:A完成] [tool_use:B完成]    │
                 │               │             │
                 ▼               ▼             │
           执行 tool A     执行 tool B         │
           (已完成 ✓)      (已完成 ✓)          │ 流式结束
                                               ▼
收集结果（await earlyPromise → 秒出）
发送 tool_result 给 API
```

## 架构设计

整个机制由三个组件协作：

```
┌─────────────────────────────────────────────────────┐
│                    chat() — Agent Loop               │
│                                                     │
│  earlyExecutions = new Map()                        │
│       │                                             │
│       ▼                                             │
│  callApi(onToolBlockComplete) ──────────────────┐   │
│       │                                         │   │
│       │   streamEvent handler:                  │   │
│       │   ┌──────────────────────────────────┐  │   │
│       │   │ toolBlocksByIndex (Map)          │  │   │
│       │   │                                  │  │   │
│       │   │ content_block_start(tool_use)    │  │   │
│       │   │   → 记录 {id, name, inputJson}   │  │   │
│       │   │                                  │  │   │
│       │   │ content_block_delta(input_json)  │  │   │
│       │   │   → 拼接 JSON 片段               │  │   │
│       │   │                                  │  │   │
│       │   │ content_block_stop               │  │   │
│       │   │   → JSON.parse → 回调            │──┘   │
│       │   └──────────────────────────────────┘      │
│       │                                             │
│       ▼                                             │
│  onToolBlockComplete(block):                        │
│    if CONCURRENCY_SAFE_TOOLS.has(name)              │
│      && checkPermission() === 'allow'               │
│        → earlyExecutions.set(id, Promise)           │
│                                                     │
│  工具执行循环:                                       │
│    for toolUse of toolUses:                         │
│      earlyPromise = earlyExecutions.get(id)         │
│      if earlyPromise → await（秒出）→ continue      │
│      else → 常规权限检查 + 执行                      │
└─────────────────────────────────────────────────────┘
```

## 涉及的文件和关键代码

### `src/tools/index.ts` — CONCURRENCY_SAFE_TOOLS

```typescript
export const CONCURRENCY_SAFE_TOOLS = new Set([
  'read_file',
  'list_files',
  'grep_search',
]);
```

准入条件：
1. **无副作用** — 纯读取操作，不修改文件系统
2. **无顺序依赖** — 多个工具的结果互不影响

`run_shell` 不纳入，因为 shell 命令可能修改系统状态。

### `src/agent.ts` — 三个协作部分

#### 1. StreamedToolUseBlock 类型

```typescript
interface StreamedToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, any>;
}
```

SDK 的 `Anthropic.ToolUseBlock` 要求 `caller` 等字段，但流式事件中没有这些信息。
这个轻量接口只携带提前执行所需的最小字段。

#### 2. callApi() — 流式 tool_use block 追踪

核心数据结构是 `toolBlocksByIndex`：

```typescript
const toolBlocksByIndex = new Map<
  number,                                    // key: 流式事件的 index（block 序号）
  { id: string; name: string; inputJson: string }  // value: 累积的 block 信息
>();
```

工作流程：

| 流式事件 | 动作 |
|---------|------|
| `content_block_start` (type=tool_use) | 创建条目：记录 `id`、`name`，`inputJson=""` |
| `content_block_delta` (type=input_json_delta) | 拼接：`tb.inputJson += delta.partial_json` |
| `content_block_stop` | 解析 JSON → 构造 `StreamedToolUseBlock` → 触发回调 → 删除条目 |

Anthropic 的流式 API 以增量方式发送 tool_use 的 JSON 输入参数（`input_json_delta`），
每个 delta 只包含部分 JSON 片段（如 `{"file_`、`path": "src/ag`、`ent.ts"}`），
必须累积拼接后才能 `JSON.parse` 得到完整的输入对象。

#### 3. chat() — earlyExecutions 生产/消费

**生产端**（`callApi` 的回调中，流式阶段触发）：

```typescript
const earlyExecutions = new Map<string, Promise<string>>();

const response = await this.callApi((block) => {
  if (CONCURRENCY_SAFE_TOOLS.has(block.name)) {
    const perm = checkPermission(block.name, input, ...);
    if (perm.action === 'allow') {
      earlyExecutions.set(
        block.id,
        Promise.resolve(executeTool(block.name, input, this.readFileState)),
      );
    }
  }
});
```

**消费端**（工具执行循环中，流式结束后）：

```typescript
for (const toolUse of toolUses) {
  const earlyPromise = earlyExecutions.get(toolUse.id);
  if (earlyPromise) {
    const raw = await earlyPromise;   // 工具已执行完毕，立即返回
    // ... push to toolResults
    continue;                         // 跳过常规权限检查
  }
  // ... 常规路径：权限检查 → 执行
}
```

## 安全保障

| 场景 | 处理方式 |
|------|---------|
| 危险 shell 命令（`rm`、`sudo`） | `run_shell` 不在 `CONCURRENCY_SAFE_TOOLS` 中，永远走常规路径 |
| 需用户确认的操作 | 回调中检查 `perm.action === 'allow'`，非 allow 不提前启动 |
| Plan 模式 | 读操作在 plan 模式下 `action=allow`，正常提前执行；写操作 `action=deny`，不在安全集合中 |
| MCP 工具 | MCP 工具名有 `mcp__` 前缀，不在 `CONCURRENCY_SAFE_TOOLS` 中 |
| JSON 解析失败 | `try/catch` 传空对象 `{}`，不阻塞流式处理，工具会因缺少参数返回错误 |
| `executeTool` 是同步函数 | 用 `Promise.resolve()` 包装，统一为 Promise 接口 |

## 局限性

1. **当前 `executeTool` 是同步的** — `Promise.resolve(executeTool(...))` 本质上在回调
   触发时同步执行完毕。真正的并发收益来自"第一个 block 完成时就开始执行，不等后续 block"，
   而非多个工具在不同线程并行（Node.js 单线程）。如果未来引入异步工具（如网络请求），
   收益会更明显。

2. **模型可能只返回一个 tool_use** — 如果模型决定串行调用工具（先读 A，根据内容决定读 B），
   每次响应只有一个 tool_use block，此时 early execution 退化为和原来一样的行为。

3. **`earlyExecutions` 每轮重建** — Map 在 `while(true)` 循环内创建，每轮 API 调用独立，
   不会跨轮泄漏状态。
