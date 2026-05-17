# Memory 语义召回系统设计文档

> 基于 `src/memory.ts` + `src/agent.ts` 实际实现，版本：2026-05-17

---

## 1. 为什么需要记忆系统

### 1.1 问题本质

Agent 的每次会话是**无状态**的。用户在上一次会话中告诉 Agent 的信息（角色、偏好、项目背景、纠正过的行为），在新会话中完全丢失。用户不得不反复解释相同的上下文。

```
会话 1: "我是后端工程师，用 Go 写微服务，测试必须用真数据库不要 mock"
会话 2: "我是后端工程师，用 Go 写微服务，测试必须用真数据库不要 mock" ← 重复
会话 3: "我是后端工程师……"  ← 又来了
```

### 1.2 设计目标

| 目标 | 要求 |
|------|------|
| **跨会话持久化** | 记忆保存在磁盘上，新会话自动可用 |
| **语义召回** | 不是简单全量加载，而是根据当前查询智能选择相关记忆 |
| **零阻塞** | 记忆召回异步进行，不增加用户等待时间 |
| **预算控制** | 记忆不能无限占用上下文空间（60KB 上限） |
| **项目隔离** | 不同工作目录的记忆互不干扰 |

---

## 2. 架构总览

### 2.1 数据流

```
用户输入
  │
  ▼
┌──────────────────┐
│ 三重门控检查      │ ← isQuerySubstantial() + 预算检查 + 记忆存在性
│                  │
│ 不通过 → 跳过召回 │
└────────┬─────────┘
         │ 通过
         ▼
┌──────────────────┐     ┌────────────────────┐
│ startMemory      │     │                    │
│ Prefetch()       │────>│ 异步 sideQuery     │ ← 后台 LLM 调用 (max_tokens=256)
│ (返回句柄)       │     │ selectRelevant     │
└────────┬─────────┘     │ Memories()         │
         │               └────────┬───────────┘
         ▼                        │
┌──────────────────┐              │
│ Agent Loop       │              │
│ while (true) {   │              │
│   // 每次迭代    │              │
│   // 检查预取    │◄─────────────┘ settled=true 后消费结果
│   // 注入记忆    │
│   // callApi()   │ ← 模型看到注入的记忆
│ }                │
└──────────────────┘
```

### 2.2 文件结构

```
src/
├── frontmatter.ts    ← YAML frontmatter 解析器（被 memory.ts 依赖）
├── memory.ts         ← 核心记忆模块（CRUD + 扫描 + 语义召回 + 系统提示）
├── agent.ts          ← 集成点（buildSideQuery + chat() 预取/消费）
└── index.ts          ← /memory REPL 命令

~/.coding-agent/
└── projects/
    └── {sha256-hash}/           ← 每个项目独立的记忆目录
        └── memory/
            ├── MEMORY.md        ← 自动生成的索引文件
            ├── user_role.md     ← 用户类记忆
            ├── feedback_testing.md
            ├── project_deadline.md
            └── reference_docs.md
```

### 2.3 模块依赖关系

```
frontmatter.ts (叶节点，零依赖)
       │
       ▼
memory.ts (依赖 frontmatter.ts + Node.js 内置模块)
       │
       ├──> agent.ts (import 预取/注入/系统提示函数)
       └──> index.ts (import listMemories 展示命令)
```

---

## 3. 存储设计

### 3.1 项目隔离

每个工作目录有独立的记忆空间，通过 SHA-256 哈希实现隔离：

```typescript
function getProjectHash(): string {
  return createHash('sha256').update(process.cwd()).digest('hex').slice(0, 16);
}
// /Users/user/project-a → "a3f8e2c1b9d04567"
// /Users/user/project-b → "7e9f1a2b3c4d5e6f"
```

**为什么用 SHA-256 哈希而非目录名？**
- 避免特殊字符（空格、中文、符号）导致的文件系统问题
- 确保唯一性（不同路径下的同名目录不会冲突）
- 16 个 hex 字符 = 64 位，碰撞概率 ≈ 2⁻³² ≈ 两亿分之一

### 3.2 记忆文件格式

每个记忆是一个带 YAML frontmatter 的 Markdown 文件：

```markdown
---
name: 用户角色
description: 用户是高级后端工程师，熟悉 Go 和 Kubernetes
type: user
---

用户是一位有 10 年经验的后端工程师，主要使用 Go 语言开发微服务。
对 Kubernetes、gRPC、PostgreSQL 非常熟悉。
前端经验较少，React 相关的解释需要从后端类比切入。
```

**文件名规则**：`{type}_{slugified_name}.md`
- 例如：`user_role.md`、`feedback_testing.md`、`project_q1_deadline.md`

### 3.3 四种记忆类型

| 类型 | 用途 | 示例 |
|------|------|------|
| `user` | 用户角色、偏好、知识水平 | "用户是数据科学家，正在研究日志系统" |
| `feedback` | 用户纠正和指导（含 Why + How to apply） | "测试必须用真数据库不要 mock，因为上季度 mock 测试通过但生产迁移失败" |
| `project` | 进行中的工作、目标、截止日期 | "2026-03-05 后代码冻结，移动端要切分支" |
| `reference` | 外部资源指针 | "pipeline 的 bug 追踪在 Linear 的 INGEST 项目" |

### 3.4 MEMORY.md 索引

自动生成的索引文件，每次 `saveMemory()` / `deleteMemory()` 后重建：

```markdown
# Memory Index

- **[用户角色](user_role.md)** (user) — 用户是高级后端工程师
- **[测试规范](feedback_testing.md)** (feedback) — 不要用 mock，必须用真数据库
```

索引会注入到系统提示中，让模型知道当前有哪些记忆可用。

**截断保护**：
- 超过 200 行 → 截断 + 追加 `[... truncated ...]`
- 超过 25KB → 截断 + 追加 `[... truncated ...]`

---

## 4. 语义召回算法

### 4.1 三重门控

`startMemoryPrefetch()` 在发起 LLM 调用前执行三个检查，任一不通过则直接返回 `null`（不发起调用）：

```
门控 1: isQuerySubstantial(query)
  ├── 2+ CJK 字符 → 通过
  ├── 包含空格（多词）→ 通过
  └── 单个英文单词 → 不通过（如 "hi"、"test"、"/clear"）

门控 2: sessionMemoryBytes < 60KB
  └── 超过 60KB → 不通过（本会话已注入够多记忆）

门控 3: 磁盘上至少有一个 .md 记忆文件
  └── 空目录 → 不通过（没有记忆可召回）
```

**为什么需要门控？**
- 避免对无意义的输入浪费 API 调用和 token
- 防止记忆无限占用上下文空间
- 首次使用（无记忆）时零开销

### 4.2 记忆选择流程

`selectRelevantMemories()` 的完整算法：

```
Step 1: scanMemoryHeaders()
  │  仅读每个文件的前 30 行（frontmatter 区域）
  │  提取 filename、description、type、mtime
  │  按 mtime 降序排列，限制最多 200 个
  ▼
Step 2: 过滤已展示记忆
  │  filter(h => !alreadySurfaced.has(h.filePath))
  ▼
Step 3: formatMemoryManifest(candidates)
  │  生成清单文本，每行一条记忆：
  │  "- [user] user_role.md (2025-01-15T10:30:00.000Z): 用户是高级后端工程师"
  ▼
Step 4: sideQuery(SELECT_MEMORIES_PROMPT, query + manifest)
  │  发送给 LLM（max_tokens=256），让模型选择相关记忆
  │  模型返回 JSON: { "selected_memories": ["user_role.md", ...] }
  ▼
Step 5: 解析 JSON，映射回候选记忆
  │  最多选 5 个文件名
  ▼
Step 6: 读取完整内容
  │  每个文件内容截断到 4KB（MAX_MEMORY_BYTES_PER_FILE）
  │  生成展示用头部文本（含新鲜度警告）
  ▼
Step 7: 返回 RelevantMemory[]
```

### 4.3 sideQuery 系统提示词

```
You are selecting memories that will be useful to an AI coding assistant
as it processes a user's query. You will be given the user's query and
a list of available memory files with their filenames and descriptions.

Return a JSON object with a "selected_memories" array of filenames for
the memories that will clearly be useful (up to 5). Only include memories
that you are certain will be helpful based on their name and description.
- If you are unsure if a memory will be useful, do not include it.
- If no memories would clearly be useful, return an empty array.
```

**关键设计**：提示词要求模型"确定有用才选"（conservative selection），宁可漏选不可错选，因为注入无关记忆会浪费上下文空间和分散模型注意力。

### 4.4 新鲜度警告

超过 1 天的记忆会附加警告文本，提醒模型验证：

```
This memory is 15 days old. Memories are point-in-time observations,
not live state — claims about code behavior may be outdated.
Verify against current code before asserting as fact.
```

1 天内的记忆使用友好标签：`Memory (saved today):`

---

## 5. Agent 集成

### 5.1 系统提示注入

在 Agent 构造函数中，将记忆系统提示段落附加到基础系统提示末尾：

```typescript
this.baseSystemPrompt = buildSystemPrompt() + '\n\n' + buildMemoryPromptSection();
```

`buildMemoryPromptSection()` 的输出包含：
1. 记忆目录路径
2. 四种类型及用途说明
3. 如何用 `write_file` 创建记忆（含 frontmatter 格式示例）
4. 什么不应保存
5. 当前 MEMORY.md 索引内容

### 5.2 buildSideQuery()

Agent 类提供一个工厂方法，将自身的 Anthropic 客户端和模型包装为 `SideQueryFn`：

```typescript
private buildSideQuery(): SideQueryFn {
  const client = this.client;
  const model = this.model;
  return async (system, userMessage, signal?) => {
    const resp = await client.messages.create({
      model, max_tokens: 256, system,
      messages: [{ role: "user", content: userMessage }],
    }, { signal });
    return resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text).join("");
  };
}
```

**为什么不用流式？** 响应极短（<256 tokens），流式开销不值得。这是后台异步调用，不需要向用户展示中间结果。

### 5.3 chat() 方法中的预取与消费

```typescript
async chat(userMessage: string): Promise<void> {
  this.messages.push({ role: 'user', content: userMessage });
  // ...

  await this.checkAndCompact();

  // ── Step 1: 启动异步预取 ──
  let memoryPrefetch = startMemoryPrefetch(
    userMessage, sideQuery, this.alreadySurfacedMemories,
    this.sessionMemoryBytes, this.abortController.signal,
  );

  while (true) {
    this.runCompressionPipeline();

    // ── Step 2: 消费预取结果（非阻塞轮询）──
    if (memoryPrefetch?.settled && !memoryPrefetch.consumed) {
      memoryPrefetch.consumed = true;
      const memories = await memoryPrefetch.promise;
      if (memories.length > 0) {
        // 追加到最后一条 user 消息（维持 API 交替规则）
        const injectionText = formatMemoriesForInjection(memories);
        // ...append to last user message...
        for (const m of memories) {
          this.alreadySurfacedMemories.add(m.path);
          this.sessionMemoryBytes += Buffer.byteLength(m.content);
        }
      }
    }

    const response = await this.callApi(...); // 模型已看到注入的记忆
    // ...
  }
}
```

**注入位置选择**：记忆追加到最后一条 `user` 消息中（而非作为独立消息），原因是 Anthropic API 要求消息严格交替（user → assistant → user → ...），插入额外的 user 消息会违反此规则。

### 5.4 MemoryPrefetch 句柄

```typescript
interface MemoryPrefetch {
  promise: Promise<RelevantMemory[]>;  // 异步结果
  settled: boolean;                     // 完成标志（resolve/reject 后为 true）
  consumed: boolean;                    // 消费标志（防止重复读取）
}
```

**为什么用句柄模式而非直接 await？**

预取的 LLM 调用需要时间（~1-3 秒），如果在 `chat()` 入口处直接 await，会阻塞用户体验。句柄模式让预取在后台异步运行，主循环在每次迭代时"顺便检查"是否已完成。如果第一轮 API 调用时预取还没完成，记忆会在后续轮次注入——模型不会错过，只是稍晚看到。

---

## 6. 预算与限制

### 6.1 层级预算

| 层级 | 限制 | 说明 |
|------|------|------|
| **单文件** | 4,096 bytes | 单个记忆文件注入时的截断上限 |
| **单次选择** | 5 条 | sideQuery 最多选择 5 条记忆 |
| **会话总量** | 60 KB | 累计注入超过 60KB 后停止预取 |
| **文件数量** | 200 个 | scanMemoryHeaders() 最多处理 200 个文件 |
| **索引大小** | 200 行 / 25KB | MEMORY.md 的截断上限 |

### 6.2 预算计算

60KB ≈ 15,000 tokens（按 4 字符/token 估算），占 200K 上下文窗口的 ~7.5%。这是经验值——足够提供充分的上下文，又不至于挤占工具调用和模型推理的空间。

### 6.3 会话级去重

`alreadySurfacedMemories: Set<string>` 跟踪本会话中已展示过的记忆文件路径。同一条记忆在一个会话中只注入一次。

**生命周期**：与 Agent 实例相同。`clearHistory()` 会重置此集合和 `sessionMemoryBytes` 计数器。

---

## 7. 容错设计

| 场景 | 处理方式 |
|------|----------|
| 记忆文件损坏（无法解析 frontmatter） | `try/catch` 静默跳过，不影响其他文件 |
| sideQuery 调用失败（网络/限流） | 返回空数组，不阻塞主循环 |
| AbortSignal 触发（用户 Ctrl+C） | 立即返回空数组 |
| JSON 解析失败（模型返回非 JSON） | 正则 `/{[\s\S]*}/` 匹配失败时返回空数组 |
| 记忆目录不存在 | `mkdirSync({ recursive: true })` 自动创建 |
| 磁盘空间不足 | `writeFileSync` 抛出异常，由调用方 catch |

**核心原则**：记忆召回是"锦上添花"功能，任何故障都不应影响 Agent 的核心对话能力。

---

## 8. REPL 命令

### /memory

列出当前项目的所有记忆：

```
> /memory

  Memories (3):
    [user] 用户角色 — 高级后端工程师，熟悉 Go 和 Kubernetes
    [feedback] 测试规范 — 不要用 mock，必须用真数据库
    [project] Q1 截止日期 — 2026-03-05 后代码冻结
```

无记忆时显示：`No memories saved yet.`

### 模型自主保存

模型通过 `write_file` 工具将记忆文件写入记忆目录（路径在系统提示中给出），文件需遵循 frontmatter 格式。MEMORY.md 索引由 Agent 的工具系统在写入后自动重建（通过 `updateMemoryIndex()` 在 `saveMemory()` 内调用）。

---

## 9. 与 Claude Code 的对照

本实现参考了 Claude Code 的记忆架构，以下是关键对应关系：

| 功能点 | Claude Code | 本实现 |
|--------|-------------|--------|
| 存储位置 | `~/.claude/projects/{hash}/memory/` | `~/.coding-agent/projects/{hash}/memory/` |
| 记忆类型 | user, feedback, project, reference | 相同 |
| 索引文件 | MEMORY.md | 相同 |
| 语义召回 | sideQuery + semantic selection | 相同算法 |
| 预取模式 | MemoryPrefetch 句柄 | 相同模式 |
| 会话预算 | 60KB | 相同 |
| 单文件限制 | 4KB | 相同 |
| 门控条件 | substantial + budget + exists | 相同 |

---

## 10. 关键文件索引

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/frontmatter.ts` | ~90 | YAML frontmatter 解析/格式化 |
| `src/memory.ts` | ~430 | 记忆 CRUD + 扫描 + 语义召回 + 预取 + 系统提示 |
| `src/agent.ts` (修改) | — | buildSideQuery() + chat() 预取/消费 + clearHistory() 重置 |
| `src/index.ts` (修改) | — | /memory REPL 命令 |
