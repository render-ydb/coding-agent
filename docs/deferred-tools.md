# 动态工具过滤（Deferred Tool Activation）

每次 API 调用都会发送所有工具的完整 JSON Schema 给模型，每个工具约消耗 200-500 token。对于不常用的工具（如 `enter_plan_mode`、`exit_plan_mode`），这是纯粹的浪费。动态工具过滤通过**延迟加载**机制解决这个问题：不常用工具默认只以名称形式告知模型，模型在需要时通过 `tool_search` 按需激活。

## 核心概念

| 概念 | 说明 |
|------|------|
| `deferred` 标记 | `ToolDefinition` 上的可选布尔标志。标记为 `deferred: true` 的工具不随每次 API 请求发送完整 schema |
| `activatedTools` | 模块级 `Set<string>`，记录已被激活的 deferred 工具名。一旦激活，后续请求自动包含完整 schema |
| `tool_search` 工具 | 模型用来搜索和激活 deferred 工具的入口。按关键词模糊匹配工具名称和描述 |
| `getActiveToolDefinitions()` | 每次 API 调用前的过滤函数。返回"非 deferred + 已激活 deferred"的工具列表 |
| `getDeferredToolNames()` | 返回尚未激活的 deferred 工具名列表，注入 system prompt 让模型知晓其存在 |

## 工作流程

```
┌──────────────────────────────────────────────────────────────────────┐
│                         Agent 启动时                                  │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  1. 构建 system prompt，包含 deferred 工具名列表：                     │
│     "以下工具可用但需通过 tool_search 激活：                            │
│      - enter_plan_mode                                               │
│      - exit_plan_mode"                                               │
│                                                                      │
│  2. 每次 API 调用：                                                   │
│     getActiveToolDefinitions()                                       │
│       → 过滤掉未激活的 deferred 工具                                   │
│       → 节省 ~400-1000 token / 次                                    │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│                     模型需要使用 deferred 工具时                       │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  3. 模型调用 tool_search(query="plan")                               │
│       ↓                                                              │
│  4. searchAndActivateTools() 模糊匹配：                               │
│     - enter_plan_mode ✓ (名称包含 "plan")                            │
│     - exit_plan_mode  ✓ (名称包含 "plan")                            │
│       ↓                                                              │
│  5. 匹配到的工具加入 activatedTools Set                               │
│     返回完整 schema 给模型（JSON 格式）                                │
│       ↓                                                              │
│  6. 后续 API 调用自动包含 enter_plan_mode、exit_plan_mode 的 schema   │
│     模型现在可以正常调用这些工具                                       │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

## 数据流

```
                    ┌─────────────────────┐
                    │  ToolDefinition[]   │
                    │  (builtin/index.ts) │
                    └──────────┬──────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
              ▼                ▼                ▼
     ┌────────────┐   ┌──────────────┐  ┌──────────────┐
     │ deferred:  │   │ deferred:    │  │ 无 deferred  │
     │   false    │   │   true       │  │ 标记（默认） │
     │ (非延迟)   │   │ (延迟加载)   │  │ (非延迟)     │
     └─────┬──────┘   └──────┬───────┘  └──────┬───────┘
           │                 │                  │
           │    ┌────────────┴────────────┐     │
           │    │                         │     │
           │    ▼                         ▼     │
           │  getDeferredToolNames()   tool_search  │
           │    │ 注入 system prompt     │ 模糊匹配  │
           │    │ (仅名称，省 token)     │ 激活匹配项 │
           │    │                        ▼          │
           │    │               activatedTools Set  │
           │    │                        │          │
           ▼    ▼                        ▼          ▼
        ┌────────────────────────────────────────────┐
        │      getActiveToolDefinitions()            │
        │  过滤: !deferred || activatedTools.has()   │
        │  → 返回 Anthropic.Tool[]                   │
        └─────────────────┬──────────────────────────┘
                          │
                          ▼
                ┌──────────────────┐
                │  API 请求 tools  │
                │  参数            │
                └──────────────────┘
```

## 当前 Deferred 工具

| 工具名 | 用途 | 为什么延迟？ |
|--------|------|-------------|
| `enter_plan_mode` | 进入只读规划阶段 | 仅在用户需要规划时使用，大多数对话不涉及 |
| `exit_plan_mode` | 退出规划阶段，提交 plan 给用户审批 | 与 enter_plan_mode 配对，同样低频 |

## 如何新增 Deferred 工具

只需在工具定义中添加 `deferred: true`，无需修改其他文件：

```typescript
// src/tools/builtin/my-rare-tool.ts
export const myRareTool: ToolDefinition = {
  definition: {
    name: 'my_rare_tool',
    description: 'A rarely used tool that does something special',
    input_schema: {
      type: 'object' as const,
      properties: { /* ... */ },
    },
  },
  execute: (input) => { /* ... */ },
  deferred: true,  // ← 仅此一行
};
```

系统会自动：
1. 从 API 请求中省略该工具的完整 schema
2. 在 system prompt 中列出该工具名
3. 模型通过 `tool_search` 搜索时能匹配到并激活

## 文件清单

| 文件 | 职责 |
|------|------|
| `src/tools/types.ts` | `ToolDefinition` 接口定义 `deferred?: boolean` 字段 |
| `src/tools/builtin/tool-search.ts` | `tool_search` 工具的 LLM schema 定义 |
| `src/tools/builtin/plan-mode.ts` | `enter_plan_mode` / `exit_plan_mode` 标记 `deferred: true` |
| `src/tools/builtin/index.ts` | 注册 `toolSearch` 到内置工具列表 |
| `src/tools/index.ts` | `activatedTools` 状态、`getActiveToolDefinitions()`、`getDeferredToolNames()`、`searchAndActivateTools()` |
| `src/agent.ts` | `callApi()` 使用 `getActiveToolDefinitions()`；system prompt 注入 deferred 工具名 |

## 关键设计决策

### 为什么 activatedTools 是模块级状态而非 Agent 实例属性？

工具定义是全局共享的（`builtinTools` 是模块级数组）。多个子 Agent 可能使用同一个工具集，一旦工具被激活就没有理由再隐藏。放在模块级与 `builtinTools` 保持相同作用域，逻辑内聚。

### 为什么 tool_search 的执行逻辑在 index.ts 而非 tool-search.ts？

`searchAndActivateTools()` 需要读取 `builtinTools` 列表（遍历所有 deferred 工具）并写入 `activatedTools` Set。这两者都是 `tools/index.ts` 的模块级状态。如果放在 `tool-search.ts`，要么产生循环导入，要么需要额外的依赖注入机制，增加不必要的复杂度。

### 为什么 tool_search 本身不是 deferred 的？

`tool_search` 是激活 deferred 工具的唯一入口。如果它自己也是 deferred 的，模型就没有途径激活它，形成死锁。它必须始终在 API 请求中可用。

### 为什么用模糊匹配而非精确匹配？

模型可能不知道工具的确切名称（system prompt 中只列了名字），用关键词搜索更容易命中。例如搜索 "plan" 能同时匹配 `enter_plan_mode` 和 `exit_plan_mode`，模型不必发起两次搜索。

### 激活后能否反激活（deactivate）？

当前设计中不支持。工具一旦激活就持续到进程结束（或调用 `resetActivatedTools()`）。理由：
1. 激活是低频操作（整个会话通常只激活一次）
2. 反激活可能导致模型在需要工具时突然发现它不可用，产生混乱
3. `resetActivatedTools()` 提供了会话清理能力，足够覆盖需要重置的场景

### Token 节省估算

每个工具 schema 约 200-500 token（取决于参数数量和描述长度）。当前 2 个 deferred 工具 × 约 300 token = 每次 API 调用节省约 600 token。随着未来标记更多低频工具为 deferred，节省量会线性增长。

对于一个 20 轮的典型对话：
- 节省：20 × 600 = 12,000 token（输入端）
- 成本节省：约 $0.036（按 $3/1M input tokens）
- 额外开销：仅在模型需要 plan mode 时多一次 `tool_search` 调用（约 200 token）
