# MCP 集成设计文档

> 基于 `src/mcp.ts` + `src/agent.ts` 实际实现，版本：2026-05-16

---

## 1. 概述

### 1.1 什么是 MCP

MCP（Model Context Protocol）是 Anthropic 推出的开放协议，让 AI 应用通过标准化接口连接外部工具和数据源。

本项目实现了 MCP **客户端侧**，通过 JSON-RPC 2.0 over stdio 与 MCP 服务器通信。

```
用户配置 MCP 服务器 → Agent 启动时自动连接 → 发现工具 → 模型按需调用
```

### 1.2 解决什么问题

| 痛点 | MCP 如何解决 |
|------|-------------|
| 内置工具有限，无法覆盖所有场景 | 通过 MCP 协议接入任意第三方工具 |
| 每种外部工具都要写专门的集成代码 | MCP 提供统一协议，一次实现即可接入所有 MCP 服务器 |
| 工具生态碎片化 | MCP 是行业标准，社区已有大量可用服务器（GitHub、数据库、搜索等） |

---

## 2. 快速开始

### 2.1 配置 MCP 服务器

在项目根目录创建 `.mcp.json`：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    }
  }
}
```

也可以在 `.claude/settings.json` 中配置：

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "ghp_xxx"
      }
    }
  }
}
```

### 2.2 启动 Agent

```bash
npx tsx src/index.ts
```

启动时控制台会显示 MCP 连接状态：

```
[mcp] Connected to 'filesystem' — 5 tools
[mcp] Connected to 'github' — 12 tools
```

如果某个服务器连接失败，会跳过并显示错误原因，不影响其他功能：

```
[mcp] Failed to connect to 'broken-server': timeout
```

### 2.3 使用 MCP 工具

无需额外操作。MCP 工具会和内置工具一起发送给模型，模型会自动判断何时使用：

```
> 列出 /tmp 下的所有文件

  🔨 mcp__filesystem__list_directory: {"path":"/tmp"}
  ◀ mcp__filesystem__list_directory:
    file1.txt
    file2.log
    ... (3 lines)
```

---

## 3. 架构设计

### 3.1 整体架构

```
┌──────────────────────────────────────────────────────┐
│                    Agent (agent.ts)                    │
│                                                        │
│  ┌────────────────┐    ┌───────────────────────────┐  │
│  │  内置工具系统    │    │    MCP 工具系统            │  │
│  │  (tools/)       │    │    (mcp.ts)               │  │
│  │  ┌────────────┐ │    │    ┌───────────────────┐  │  │
│  │  │ read_file  │ │    │    │   McpManager      │  │  │
│  │  │ write_file │ │    │    │   ┌─────────────┐ │  │  │
│  │  │ edit_file  │ │    │    │   │ Connection 1│──────> MCP Server 1
│  │  │ grep_search│ │    │    │   │ Connection 2│──────> MCP Server 2
│  │  │ list_files │ │    │    │   │ ...         │ │  │  │
│  │  │ run_shell  │ │    │    │   └─────────────┘ │  │  │
│  │  └────────────┘ │    │    └───────────────────┘  │  │
│  └────────────────┘    └───────────────────────────┘  │
│                                                        │
│  工具路由优先级：                                        │
│  1. plan mode 工具 → Agent 内部处理                      │
│  2. mcp__ 前缀     → McpManager 路由                    │
│  3. 其他           → executeTool() 内置系统              │
└──────────────────────────────────────────────────────┘
```

### 3.2 关键设计决策

#### 决策 1：MCP 独立于内置工具系统

内置工具的 `executeTool()` 是**同步**的（返回 `string`），而 MCP 调用是**异步**的（子进程 JSON-RPC 通信）。将两者分离避免了把整个工具系统改为异步。

```
Agent Loop 中的路由逻辑：

for (const toolUse of toolUses) {
  if (plan mode 工具)  → 内部处理
  if (mcp__ 前缀)      → await mcpManager.callTool()   // 异步
  if (内置工具)         → executeTool()                 // 同步
}
```

#### 决策 2：零 SDK 依赖

没有使用官方 MCP SDK，而是直接实现 JSON-RPC 2.0 over stdio。

理由：
- MCP 的 stdio 传输层非常简单（逐行 JSON + request/response ID 匹配）
- 避免引入重依赖（官方 SDK 包含 HTTP/SSE 传输等不需要的功能）
- 全部用 Node.js 内置模块：`child_process`、`readline`、`fs`

#### 决策 3：`mcp__` 命名空间前缀

所有 MCP 工具以 `mcp__<serverName>__<toolName>` 格式命名：

```
mcp__github__create_issue
mcp__filesystem__read_file
mcp__database__query
```

使用双下划线 `__` 而非单下划线 `_`，因为工具名中经常包含 `_`，单下划线会导致解析歧义。

#### 决策 4：懒加载

MCP 服务器在 Agent 首次 `chat()` 调用时才连接，而非构造时：

- 构造函数不支持 async，无法在其中做 I/O
- 如果用户没有配置 MCP 服务器，零开销
- `mcpInitialized` 标志确保只连接一次

#### 决策 5：优雅降级

单个 MCP 服务器连接失败（超时、进程错误、配置错误）不会影响：
- 其他 MCP 服务器的连接
- 内置工具的正常使用
- Agent 的主循环

---

## 4. 模块详解

### 4.1 `McpConnection` 类（私有）

管理与单个 MCP 服务器的通信。

```
┌──────────────┐         stdin          ┌──────────────┐
│              │ ────────────────────>   │              │
│  McpConnection│   JSON-RPC request    │  MCP Server  │
│              │ <────────────────────  │  (子进程)     │
│              │   JSON-RPC response    │              │
└──────────────┘         stdout         └──────────────┘
```

**核心数据结构：`pending` Map**

```typescript
private pending = new Map<number, { resolve, reject }>();
```

请求-响应的关联机制：
1. `sendRequest()` 分配自增 ID，存入 `pending`，写入 stdin
2. `readline` 逐行解析 stdout，解出 JSON-RPC 响应
3. 通过 `id` 匹配到对应的 Promise，调用 resolve 或 reject

**MCP 协议握手流程：**

```
Client                          Server
  │                                │
  │──── initialize ───────────────>│  (声明协议版本)
  │<─── result ───────────────────│  (返回服务器能力)
  │                                │
  │──── notifications/initialized─>│  (通知，无响应)
  │                                │
  │──── tools/list ───────────────>│  (发现工具)
  │<─── result ───────────────────│  (工具列表)
  │                                │
  │     ... 握手完成，可以调用工具 ...  │
```

### 4.2 `McpManager` 类（导出）

Agent 与 MCP 生态的唯一接口。

| 方法 | 作用 | 调用时机 |
|------|------|---------|
| `loadAndConnect()` | 加载配置、连接所有服务器 | `chat()` 首次调用 |
| `getToolDefinitions()` | 返回 Anthropic Tool 格式的工具定义 | MCP 初始化后 |
| `isMcpTool(name)` | 判断工具名是否有 `mcp__` 前缀 | 每次工具执行前 |
| `callTool(name, args)` | 路由调用到对应服务器 | 模型调用 MCP 工具时 |
| `disconnectAll()` | 关闭所有连接 | 进程退出时（可选） |

**工具名解析逻辑：**

```
"mcp__my_server__tool_name" → split("__") → ["mcp", "my_server", "tool_name"]
                                              parts[1] = serverName
                                              parts[2:].join("__") = toolName
```

`parts.slice(2).join("__")` 确保工具名本身含有 `__` 时也能正确还原。

### 4.3 配置加载

三个配置来源，按优先级递增合并（后者覆盖同名服务器）：

| 优先级 | 路径 | 用途 |
|--------|------|------|
| 1（低）| `~/.claude/settings.json` | 全局配置，跨项目共享 |
| 2 | `${cwd}/.claude/settings.json` | 项目级配置 |
| 3（高）| `${cwd}/.mcp.json` | Claude Code 约定文件 |

支持两种 JSON 格式：

```json
// 格式 1：settings.json 风格（mcpServers 字段）
{
  "mcpServers": {
    "server-name": { "command": "...", "args": [...] }
  }
}

// 格式 2：.mcp.json 直接格式（根对象即服务器映射）
{
  "server-name": { "command": "...", "args": [...] }
}
```

验证规则：每个服务器配置必须是对象且包含 `command` 字符串字段。

---

## 5. Agent 集成点

MCP 在 `agent.ts` 中的集成共 5 处改动（全部增量，未删除或修改已有逻辑）：

### 5.1 实例变量

```typescript
private mcpManager = new McpManager();    // MCP 管理器
private mcpInitialized = false;            // 懒加载标志
private mcpTools: Anthropic.Tool[] = [];   // 工具定义缓存
```

### 5.2 懒初始化（`chat()` 入口）

```typescript
if (!this.mcpInitialized) {
  this.mcpInitialized = true;
  try {
    await this.mcpManager.loadAndConnect();
    this.mcpTools = this.mcpManager.getToolDefinitions() as Anthropic.Tool[];
  } catch (err: any) {
    console.error(`[mcp] Initialization failed: ${err.message}`);
  }
}
```

放在 `chat()` 而非构造函数中，因为 MCP 连接是异步操作。

### 5.3 工具定义合并（`callApi()`）

```typescript
// 改动前：
tools: toolDefinitions,

// 改动后：
tools: [...toolDefinitions, ...this.mcpTools],
```

当 `mcpTools` 为空时（无 MCP 配置），行为与改动前完全一致。

### 5.4 工具路由（`chat()` 工具执行循环）

在 plan mode 工具检查之后、权限检查之前插入 MCP 路由：

```
1. plan mode 工具?  → Agent 内部处理
2. mcp__ 前缀?      → MCP 路由（新增）
3. 权限检查         → checkPermission()
4. 执行内置工具      → executeTool()
```

MCP 路由包含：
- **Plan 模式守卫**：plan 模式下拒绝所有 MCP 工具调用
- **调用转发**：`await mcpManager.callTool(name, input)`
- **大结果持久化**：复用 `persistLargeResult()` 处理 >30KB 的结果
- **错误处理**：MCP 错误以 `is_error: true` 的 tool_result 返回给模型

---

## 6. 权限与安全

### 6.1 权限矩阵

| 权限模式 | MCP 工具行为 | 原因 |
|----------|-------------|------|
| `bypassPermissions` | 允许 | 用户明确跳过所有权限 |
| `acceptEdits` | 允许 | 用户已配置 MCP 服务器，表示信任 |
| `default` | 允许 | 同上 |
| `plan` | **拒绝** | Plan 模式是只读的，不允许外部副作用 |
| `dontAsk` | 允许 | MCP 工具不被视为危险操作 |

MCP 工具的权限检查在 `agent.ts` 层面独立实现（plan 模式守卫），不走 `permissions.ts` 的 `checkPermission()`。

### 6.2 安全边界

- MCP 服务器由**用户配置文件**定义，不是 Agent 自行发现的
- 服务器以子进程方式运行，继承当前用户权限
- 进程间通过 stdio pipe 通信，无网络暴露
- Agent 不执行 MCP 服务器返回的任意代码，只提取文本结果

---

## 7. 上下文压缩中的 MCP

MCP 工具结果在上下文压缩管道中的处理：

| 压缩层 | 对 MCP 结果的处理 |
|--------|-----------------|
| Tier 1: Budget | 超出字符预算时截断头尾 |
| Tier 2: Snip | **不处理**（MCP 工具名不在 `SNIPPABLE_TOOLS` 集合中） |
| Tier 3: Microcompact | 缓存冷却后清理所有旧 tool_result（包括 MCP） |
| Tier 4: Auto-compact | 摘要压缩包含 MCP 结果 |

Tier 2 不处理 MCP 结果是合理的，因为 MCP 工具不像 `read_file` 那样可以"重新读取"——模型无法确定重新调用 MCP 工具会得到相同结果。

---

## 8. 错误处理

### 8.1 启动阶段

| 错误场景 | 处理方式 |
|----------|---------|
| 配置文件不存在 | 静默跳过（正常情况） |
| 配置文件 JSON 格式错误 | 静默跳过，不影响其他配置 |
| 服务器命令不存在 | 记录错误日志，跳过该服务器 |
| 服务器初始化超时（>15s） | 记录错误日志，关闭连接，跳过 |
| 工具发现超时（>15s） | 同上 |

### 8.2 运行阶段

| 错误场景 | 处理方式 |
|----------|---------|
| MCP 服务器进程崩溃 | 拒绝所有 pending 请求，模型收到错误 tool_result |
| 工具调用返回 JSON-RPC error | 抛出异常，被 Agent 捕获，返回 `is_error: true` |
| 服务器名称不存在 | 抛出异常，同上 |
| 工具名解析失败 | 抛出异常，同上 |

模型收到错误的 tool_result 后会自行决定如何恢复（重试、换方法、告知用户）。

---

## 9. 数据流示例

以调用 `mcp__github__create_issue` 为例：

```
1. 模型返回 tool_use:
   { name: "mcp__github__create_issue", input: { title: "Bug fix", body: "..." } }

2. Agent 识别 mcp__ 前缀:
   mcpManager.isMcpTool("mcp__github__create_issue") → true

3. Plan 模式检查:
   permissionMode !== "plan" → 继续

4. 解析工具名:
   "mcp__github__create_issue".split("__") → ["mcp", "github", "create_issue"]
   serverName = "github"
   toolName = "create_issue"

5. 路由到 MCP 服务器:
   connections.get("github") → McpConnection

6. JSON-RPC 调用:
   stdin ← {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"create_issue","arguments":{...}}}

7. 接收响应:
   stdout → {"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"Issue #42 created"}]}}

8. 提取文本结果:
   "Issue #42 created"

9. 大结果检查:
   persistLargeResult() → 小于 30KB，原样返回

10. 返回给模型:
    tool_result: { content: "Issue #42 created" }
```

---

## 10. 与 Claude Code 官方实现的对比

| 特性 | 本实现 | Claude Code 官方 |
|------|--------|----------------|
| 传输协议 | stdio JSON-RPC | stdio + SSE + streamable HTTP |
| SDK 依赖 | 无（原生 JSON-RPC） | `@modelcontextprotocol/sdk` |
| 配置来源 | 3 处 settings/mcp.json | 同 |
| 工具命名 | `mcp__server__tool` | `mcp__server__tool` |
| 超时保护 | 15s（init + listTools） | 类似 |
| 多服务器 | 串行连接 | 并行连接 |
| 权限 | Plan 模式拒绝 | 细粒度权限控制 |
| 资源/提示 | 不支持 | 支持 resources/prompts |

本实现是 MVP 级别，覆盖最核心的工具发现和调用场景。后续可扩展的方向：
- 并行连接多个服务器（`Promise.all` 替代串行循环）
- 支持 MCP Resources（上下文数据注入）
- 支持 MCP Prompts（预定义提示模板）
- SSE/HTTP 传输层
- 运行时动态添加/移除服务器
