# Agent 上下文管理与压缩系统设计文档

> 基于 `src/agent.ts` 实际实现，版本：2026-05-16

---

## 1. 为什么需要上下文管理

### 1.1 问题本质

LLM 的上下文窗口是**有限且昂贵**的资源。Claude 4.x 的窗口为 200,000 tokens，看似很大，但 Agent 的 Tool-Use Loop 会快速消耗：

```
用户: "帮我修复 auth bug"
  → assistant: tool_use(read_file "src/auth.ts")        +50 tokens
  → user: tool_result(文件内容 500 行)                  +2000 tokens
  → assistant: tool_use(grep_search "validateToken")    +30 tokens
  → user: tool_result(搜索结果 200 行)                  +800 tokens
  → assistant: tool_use(read_file "src/middleware.ts")  +50 tokens
  → user: tool_result(文件内容 800 行)                  +3200 tokens
  ...
```

**一个中等复杂度的任务涉及 10-30 轮工具调用，每轮 tool_result 可能 1K-10K tokens。20 轮后轻松突破 100K tokens。**

### 1.2 不管会怎样


| 后果     | 影响                                             |
| ------ | ---------------------------------------------- |
| API 报错 | 超出 max context length，请求直接失败，任务中断              |
| 费用失控   | 每次 API 调用重发全部历史，无用旧结果被反复计费（$3/1M input tokens） |
| 质量下降   | 上下文过长时模型注意力分散，容易忽略关键信息                         |


### 1.3 设计目标

1. **永不溢出** — 无论对话多长，保证 API 不报错
2. **最小信息损失** — 优先丢弃可重新获取的数据，不丢决策和结论
3. **零额外 API 开销**（前 3 层）— 在本地操作 messages 数组即可
4. **对模型透明** — 模型能感知数据被压缩，知道如何恢复

---

## 2. 整体架构：5 层递进压缩

```
                        激进程度 ──────────────────────────────→
                        API 开销 ──────────────────────────────→

┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐
│  Tier 0  │  │  Tier 1  │  │  Tier 2  │  │  Tier 3  │  │  Tier 4  │
│ 大结果   │  │ 预算截断  │  │ 过期Snip │  │ 微压缩   │  │ 摘要压缩  │
│ 持久化   │  │          │  │          │  │          │  │          │
├──────────┤  ├──────────┤  ├──────────┤  ├──────────┤  ├──────────┤
│ >30KB    │  │ >50%利用 │  │ >60%利用 │  │ 空闲>5m  │  │ >85%利用 │
│ 写磁盘   │  │ 裁中间   │  │ 替换占位 │  │ 全部清理 │  │ API摘要  │
├──────────┤  ├──────────┤  ├──────────┤  ├──────────┤  ├──────────┤
│ 0 API    │  │ 0 API    │  │ 0 API    │  │ 0 API    │  │ 1次 API  │
│ 开销     │  │ 开销     │  │ 开销     │  │ 开销     │  │ 调用     │
└──────────┘  └──────────┘  └──────────┘  └──────────┘  └──────────┘
   入口拦截      每轮循环前     每轮循环前     每轮循环前     用户输入时
```

**核心原则：从温和到激进，成本从零到有，按需递进。**

---

## 3. 关键状态变量

以下是 `Agent` 类中驱动压缩决策的状态变量：

```typescript
// ── 上下文压缩状态 ──

private lastInputTokenCount = 0;
// 最近一次 API 调用的 response.usage.input_tokens
// 反映当前 messages 数组的实际 token 大小（非累计值）
// 压缩操作后，下次 API 调用此值自然变小

private lastApiCallTime = 0;
// 最近一次 API 调用的 Date.now() 时间戳
// 用于 Tier 3 判断 prompt cache 是否已过期（>5分钟）

private effectiveWindow: number;
// = getContextWindow(model) - 20000 = 180,000 tokens
// 20K 余量预留给: system prompt + 工具定义 + max_tokens + 元数据
```

### 利用率公式

```typescript
const utilization = this.lastInputTokenCount / this.effectiveWindow;
// 例: 108000 / 180000 = 0.60 → 触发 Tier 2
```

### 为什么用 `lastInputTokenCount` 而非累计值

Anthropic API 是无状态的——每次调用都重发全部 messages。`response.usage.input_tokens` 精确反映了**本次请求消耗了多少上下文空间**。压缩操作修改 messages 后，下次返回的 `input_tokens` 会自然减小。累计值无法反映压缩效果。

---

## 4. Tier 0：大结果持久化

**代码位置**: `agent.ts:604-625`

### 4.1 问题

某些工具单次返回极大结果：

- `grep_search` 在大项目中搜索常见模式 → 可能 200KB
- `run_shell` 执行 `find . -name "*.ts"` → 可能几千行
- `read_file` 读取大文件 → 可能 5000+ 行

100KB 文本 ≈ 25,000 tokens ≈ 有效窗口的 **14%**。一条结果就吃掉 14% 是不可接受的。

### 4.2 实现

```typescript
private persistLargeResult(toolName: string, result: string): string {
  const THRESHOLD = 30 * 1024; // 30 KB
  if (Buffer.byteLength(result) <= THRESHOLD) return result;

  // 完整结果写入磁盘（不丢失数据）
  const dir = join(homedir(), '.coding-agent', 'tool-results');
  mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${toolName}.txt`;
  const filepath = join(dir, filename);
  writeFileSync(filepath, result);

  // 上下文中只保留前 200 行预览 + 磁盘路径
  const lines = result.split('\n');
  const preview = lines.slice(0, 200).join('\n');
  const sizeKB = (Buffer.byteLength(result) / 1024).toFixed(1);

  return (
    `[Result too large (${sizeKB} KB, ${lines.length} lines). ` +
    `Full output saved to ${filepath}. ` +
    `Use read_file to see the full result.]\n\n` +
    `Preview (first 200 lines):\n${preview}`
  );
}
```

### 4.3 调用时机

在 Agent Loop 中，**工具执行完毕后、结果进入 messages 之前**（`agent.ts:547-548`）：

```typescript
const raw = executeTool(toolUse.name, input);          // 原始结果
const result = this.persistLargeResult(toolUse.name, raw); // ← 拦截
toolResults.push({ ..., content: result });            // 进入上下文
```

### 4.4 设计决策


| 决策                                        | 理由                                 |
| ----------------------------------------- | ---------------------------------- |
| 阈值 30KB                                   | ≈7,500 tokens ≈ 有效窗口的 4%，单条结果的合理上限 |
| 保留 200 行预览                                | 足够模型判断结果内容，决定是否需要完整数据              |
| 写入 `~/.coding-agent/tool-results/`        | 模型可用 `read_file` 按需读取，信息零丢失        |
| 提示 "Use read_file to see the full result" | 模型感知数据被截断，知道恢复手段                   |


### 4.5 效果

- 100KB 的 grep 结果 → 上下文中只占约 8KB（200 行预览）
- 信息不丢失：完整结果在磁盘，模型随时可以 read_file
- 防止了 Tier 1-3 需要处理的"超大单条结果"问题

---

## 5. Tier 1：预算截断（Budget）

**代码位置**: `agent.ts:725-747`

### 5.1 问题

即使 Tier 0 拦截了超大结果，10-30KB 的中等结果仍会累积。多条结果叠加后上下文迅速膨胀。但不能直接删除整条消息——Anthropic API 要求每个 `tool_use` 必须有对应的 `tool_result`，删除会导致 API 拒绝请求。

### 5.2 解决方案：原地截断，保留头尾

```typescript
private budgetToolResults(): void {
  const utilization = this.lastInputTokenCount / this.effectiveWindow;
  if (utilization < 0.5) return; // 不到 50% 不需要动

  const budget = utilization > 0.7 ? 15000 : 30000; // 动态预算（字符数）

  for (const msg of this.messages) {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content as any[]) {
      if (block.type === 'tool_result' &&
          typeof block.content === 'string' &&
          block.content.length > budget) {
        const keepEach = Math.floor((budget - 80) / 2);
        block.content =
          block.content.slice(0, keepEach) +
          `\n\n[... budgeted: ${block.content.length - keepEach*2} chars truncated ...]\n\n` +
          block.content.slice(-keepEach);
      }
    }
  }
}
```

### 5.3 为什么保留头尾

```
┌─────────── 头部（保留）─────────────┐
│ 文件前几十行 / 命令初始输出 / 搜索第一批结果    │
│ → 包含路径、签名、结构信息                     │
├─────────── 中间（裁剪）─────────────┤
│ 大量重复性代码行 / 日志条目 / 搜索结果          │
│ → 模式可推断，丢失可接受                       │
├─────────── 尾部（保留）─────────────┤
│ 错误堆栈 / 退出码 / 文件末尾 export            │
│ → 包含结论性信息                              │
└─────────────────────────────────────┘
```

### 5.4 动态预算策略


| 利用率     | 预算        | 逻辑            |
| ------- | --------- | ------------- |
| < 50%   | 不截断       | 上下文充裕，无需干预    |
| 50%~70% | 30,000 字符 | 温和截断，保留较多上下文  |
| > 70%   | 15,000 字符 | 紧凑截断，为后续轮次留空间 |


### 5.5 调用时机

每次 API 调用前，在 `runCompressionPipeline()` 中作为第一步（`agent.ts:700-704`）：

```typescript
private runCompressionPipeline(): void {
  this.budgetToolResults();  // Tier 1 — 先截断单条大结果
  this.snipStaleResults();   // Tier 2 — 再整条替换旧结果
  this.microcompact();       // Tier 3 — 最后缓存冷却时激进清理
}
```

### 5.6 不可逆性

被截断的中间内容**永远丢失**（除非 Tier 0 已将原始结果写入磁盘）。模型如需完整数据，必须重新调用工具。

---

## 6. Tier 2：过期结果 Snip

**代码位置**: `agent.ts:772-842`

### 6.1 问题

Tier 1 只缩短单条结果的体积，不减少结果的数量。当利用率超过 60%，说明积累了大量 tool_result 条目。需要更激进的策略：**整条替换为占位符**。

### 6.2 核心洞察

- 同一文件被 `read_file` 读取多次 → 只有最后一次有价值（文件可能被修改了）
- 超过 3 轮之前的工具结果 → 通常不再被模型引用
- 这些工具是只读的、可重新执行的 → snip 不是真正的"丢失"

### 6.3 可 Snip 的工具

```typescript
const SNIPPABLE_TOOLS = new Set([
  'read_file',    // 可重新读取
  'grep_search',  // 可重新搜索
  'list_files',   // 可重新列举
  'run_shell',    // 可重新执行（只读命令）
]);
```

**为什么只有这些**：它们是只读的、幂等的、输出可重现的。`edit_file` / `write_file` 的结果虽小但记录了操作历史，不可 snip。

### 6.4 算法流程

```
Step 1: 收集所有 SNIPPABLE_TOOLS 的 tool_result（跳过已 snip 的）
        通过 tool_use_id 反查 assistant 消息获取工具名和参数

Step 2: 标记需要 snip 的结果
        策略 A — 去重: 同一 file_path 的多次 read_file，只保留最后一次
        策略 B — 老化: 总数超过 KEEP_RECENT_RESULTS(3) 的旧结果全部 snip

Step 3: 将标记的结果替换为 "[Content snipped - re-read if needed]"
```

### 6.5 去重示例

```
时间线:
  t1: read_file("src/app.ts")    → 5000 chars  ← 标记 snip（旧版本）
  t2: edit_file("src/app.ts")    → "OK"        ← 不动（非 SNIPPABLE）
  t3: read_file("src/app.ts")    → 5200 chars  ← 保留（最新版本）
  t4: read_file("src/index.ts")  → 3000 chars  ← 保留（唯一一次）
```

t1 读到的是修改前的文件内容，t3 读到的是修改后的。保留 t1 不仅浪费空间，还会让模型困惑"文件到底长什么样"。

### 6.6 `findToolUseById` 辅助方法

`agent.ts:1009-1021` — 在 assistant 消息中反查指定 ID 的 tool_use block：

```typescript
private findToolUseById(toolUseId: string): { name: string; input: any } | null {
  for (const msg of this.messages) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content as any[]) {
      if (block.type === 'tool_use' && block.id === toolUseId) {
        return { name: block.name, input: block.input };
      }
    }
  }
  return null;
}
```

为什么需要这个：tool_result 中只有 `tool_use_id`，没有工具名和参数。要判断"这个结果是否属于 SNIPPABLE_TOOLS"、"是否是对同一文件的重复读取"，必须反查。

### 6.7 占位符设计

```typescript
const SNIP_PLACEHOLDER = '[Content snipped - re-read if needed]';
```

- `Content snipped` — 告诉模型"数据存在但被裁了"（不是执行失败）
- `re-read if needed` — 暗示模型可以重新调用 `read_file` 等工具恢复数据

### 6.8 KEEP_RECENT_RESULTS = 3 的选择

- **太少(1-2)**：模型刚读的文件立刻被 snip，导致不必要的重复调用
- **太多(5+)**：压缩效果不明显，利用率持续上升
- **3 是平衡点**：保留最近操作的上下文，同时及时释放旧空间

---

## 7. Tier 3：微压缩（Microcompact）

**代码位置**: `agent.ts:864-897`

### 7.1 利用 Prompt Cache 冷却期

Anthropic 的 Prompt Cache 有 **5 分钟 TTL**：

```
t=0      API 调用 → 建立缓存
t<5min   后续调用 → cache hit（便宜快速，上下文前缀不重新计算）
t=5min   缓存过期
t>5min   下次调用 → cache miss（全部重新计算，无论上下文大小）
```

**关键洞察：如果用户离开超过 5 分钟再回来，缓存已失效。此时压缩上下文不会增加任何额外成本（反正要全部重新处理），反而让"冷启动"更快更便宜。这是一个免费的压缩窗口。**

### 7.2 实现

```typescript
private microcompact(): void {
  if (!this.lastApiCallTime ||
      Date.now() - this.lastApiCallTime < MICROCOMPACT_IDLE_MS) return;
  // MICROCOMPACT_IDLE_MS = 5 * 60 * 1000

  // 收集所有未被清理的 tool_result 块（不限工具类型）
  const allResults: { msgIdx: number; blockIdx: number }[] = [];
  // ... 遍历 messages ...

  // 保留最近 3 个，清理其余所有
  const clearCount = allResults.length - KEEP_RECENT_RESULTS;
  for (let i = 0; i < clearCount && i < allResults.length; i++) {
    block.content = '[Old result cleared]';
  }
}
```

### 7.3 与 Tier 2 的区别


| 维度   | Tier 2                                  | Tier 3                 |
| ---- | --------------------------------------- | ---------------------- |
| 触发条件 | `utilization > 60%`                     | `空闲 > 5 分钟`            |
| 作用范围 | 仅 SNIPPABLE_TOOLS                       | **所有** tool_result     |
| 占位符  | `[Content snipped - re-read if needed]` | `[Old result cleared]` |
| 语义   | "可以重新读取"                                | "旧数据，已不再相关"            |
| 激进程度 | 选择性清理                                   | 批量清理                   |


### 7.4 两种占位符的语义差异

- `[Content snipped - re-read if needed]` → 暗示**模型应该重新读取**（对 read_file 等只读工具）
- `[Old result cleared]` → 暗示**数据已经过时**，通常不需要重新获取（几分钟前的 shell 输出、旧搜索结果）

模型看到 `[Old result cleared]` 时会选择从当前状态重新开始，而不是试图恢复旧数据。

---

## 8. Tier 4：自动摘要压缩

**代码位置**: `agent.ts:915-992`

### 8.1 最后防线

Tier 1-3 是"局部修补"——保持消息结构不变，只缩减内容。当利用率达到 **85%** 时，局部修补已不够，需要**彻底重建对话历史**。

方法：用一次 API 调用让模型总结整个对话，然后用摘要替换全部历史。

### 8.2 触发（`checkAndCompact`）

```typescript
private async checkAndCompact(): Promise<void> {
  if (this.lastInputTokenCount > this.effectiveWindow * 0.85) {
    console.log('\n  ℹ Context window filling up, compacting conversation...');
    await this.compactConversation();
  }
}
```

**85% 阈值的计算**：

```
有效窗口:        180,000 tokens
85% 阈值:        153,000 tokens
剩余空间:        27,000 tokens
下一轮需求:      ~21,000 tokens (max_tokens 16384 + 工具结果 ~5000)
安全余量:        ~6,000 tokens
```

再高就有溢出风险。

### 8.3 实现流程

```typescript
private async compactConversation(): Promise<void> {
  if (this.messages.length < 4) return; // 对话太短没必要压缩

  // 1. 保存当前轮的用户输入
  const lastUserMsg = this.messages[this.messages.length - 1];

  // 2. 调用 API 生成摘要（额外的一次 API 调用）
  const summaryResp = await this.client.messages.create({
    model: this.model,
    max_tokens: 2048,
    system: 'You are a conversation summarizer. Be concise but preserve important details.',
    messages: [
      ...this.messages.slice(0, -1),  // 历史消息
      { role: 'user', content: 'Summarize the conversation...' },
    ],
  });

  // 3. 用摘要重建 messages（满足 user→assistant→user 交替规则）
  this.messages = [
    { role: 'user', content: `[Previous conversation summary]\n${summaryText}` },
    { role: 'assistant', content: 'Understood. I have the context...' },
  ];
  if (lastUserMsg.role === 'user') this.messages.push(lastUserMsg);

  // 4. 重置利用率
  this.lastInputTokenCount = 0;
}
```

### 8.4 压缩前后对比

```
压缩前 (30+ 条消息, ~153K tokens):
  messages[0]:  { user: "帮我修复 login bug" }
  messages[1]:  { assistant: [text + tool_use(read_file)] }
  messages[2]:  { user: [tool_result: 文件内容] }
  messages[3]:  { assistant: [text + tool_use(edit_file)] }
  ...
  messages[28]: { user: "现在处理注册页面" }

压缩后 (3 条消息, ~3K tokens):
  messages[0]: { user: "[Previous conversation summary]\n修复了 login.ts..." }
  messages[1]: { assistant: "Understood. I have the context..." }
  messages[2]: { user: "现在处理注册页面" }
```

**上下文从 153K tokens 降到 ~3K tokens，利用率从 85% 回落到 ~2%。**

### 8.5 为什么在 `chat()` 入口而不是循环内

调用位置：`agent.ts:477`

```typescript
async chat(userMessage: string): Promise<void> {
  this.messages.push({ role: 'user', content: userMessage });
  this.abortController = new AbortController();
  try {
    await this.checkAndCompact(); // ← 这里，在 Agent Loop 之前
    while (true) { ... }
  }
}
```

原因：

1. Tier 4 需要一次额外 API 调用（有成本），不能每轮工具执行都触发
2. 放在轮次边界保证最后一条消息是**纯文本 user 消息**——slice 操作不会破坏 tool_use ↔ tool_result 配对
3. 循环内已有 Tier 1-3 的零开销压缩兜底

### 8.6 `messages.length < 4` 的保护

对话太短时压缩没有价值：

- 2 条消息：一问一答，没有可压缩的历史
- 3 条消息：一轮工具交互，摘要反而比原文更长
- ≥ 4 条消息：至少有一轮完整的工具交互历史，压缩有意义

### 8.7 消息交替规则

Anthropic API 要求严格的 `user → assistant → user → assistant` 交替。压缩后的 3 条消息：

```
messages[0]: user       ← 摘要（以 user 身份注入，模型不能"自言自语"）
messages[1]: assistant  ← 确认（人工构造，维持交替）
messages[2]: user       ← 当前轮的真实用户输入
```

### 8.8 成本分析


| 项目          | Token    | 费用         |
| ----------- | -------- | ---------- |
| 摘要请求输入（旧历史） | ~153,000 | ~$0.46     |
| 摘要请求输出      | ~2,048   | ~$0.03     |
| **总成本**     | -        | **~$0.49** |
| 后续每次请求节省    | ~150,000 | ~$0.45/次   |


**一次压缩在后续 1-2 次 API 调用中就能回本。**

---

## 9. 完整调用时序

### 9.1 Agent Loop 中的数据流

```
用户输入 "请修复 auth bug"
│
▼
chat("请修复 auth bug")                          [agent.ts:472]
│
├─ messages.push({ user: "请修复 auth bug" })    [agent.ts:473]
│
├─ checkAndCompact()                             [agent.ts:477]
│  └─ if lastInputTokenCount > 85% → Tier 4
│
└─ while (true) {                                [agent.ts:479]
   │
   ├─ runCompressionPipeline()                   [agent.ts:482]
   │  ├─ budgetToolResults()     Tier 1          [agent.ts:701]
   │  ├─ snipStaleResults()      Tier 2          [agent.ts:702]
   │  └─ microcompact()          Tier 3          [agent.ts:703]
   │
   ├─ callApi() → response                      [agent.ts:485]
   │
   ├─ 更新 lastInputTokenCount, lastApiCallTime [agent.ts:489-491]
   │
   ├─ messages.push(assistant response)          [agent.ts:494]
   │
   ├─ 有 tool_use?
   │  │ 否 → break
   │  │ 是 ↓
   │
   ├─ 执行工具:
   │  ├─ executeTool(name, input)                [agent.ts:547]
   │  ├─ persistLargeResult(name, raw)  Tier 0   [agent.ts:548]
   │  └─ toolResults.push(result)                [agent.ts:551]
   │
   ├─ messages.push({ user: toolResults })       [agent.ts:559]
   │
   └─ (循环回到 runCompressionPipeline)
```

### 9.2 典型长对话场景


| 轮次    | 利用率      | 触发层级                | 发生了什么                         |
| ----- | -------- | ------------------- | ----------------------------- |
| 1-5   | 10%-30%  | 无                   | 正常增长，无压缩                      |
| 6-8   | 35%-48%  | 无                   | 接近 Tier 1 阈值                  |
| 9     | 52%      | **Tier 1**          | 超 30K 字符的旧结果被头尾截断             |
| 10-11 | 55%-58%  | Tier 1              | 持续截断新产生的大结果                   |
| 12    | 62%      | **Tier 1 + Tier 2** | 截断 + snip 旧的/重复的 read_file 结果 |
| 13-16 | 60%-72%  | Tier 1 + Tier 2     | 双重压缩，利用率增长放缓                  |
| 17    | 78%      | Tier 1(紧凑) + Tier 2 | 预算降至 15K，更激进截断                |
| 18    | 新轮 → 86% | **Tier 4**          | 全部历史压缩为摘要，利用率回落到 ~2%          |
| 19-20 | 5%-15%   | 无                   | 从摘要重新开始，空间充裕                  |


### 9.3 用户离开 5 分钟后回来

```
t=0       Agent 完成响应，利用率 45%
t=0~5m    用户离开
t=7m      用户回来，输入新请求

chat() 入口:
  checkAndCompact(): 45% < 85% → 不触发 Tier 4

Agent Loop 第一次迭代:
  runCompressionPipeline():
    budgetToolResults(): 45% < 50% → 跳过
    snipStaleResults():  45% < 60% → 跳过
    microcompact():      7min - 0min = 7min > 5min → ✓ 触发！
      → 清理所有旧 tool_result（保留最近 3 个）
      → 下次 API 调用的 input_tokens 显著减小
```

---

## 10. 各层的信息保留策略


| 层级     | 上下文中保留什么                                | 模型如何恢复完整数据             |
| ------ | --------------------------------------- | ---------------------- |
| Tier 0 | 200 行预览 + 磁盘路径                          | `read_file` 读磁盘文件      |
| Tier 1 | 头部 + 尾部                                 | 重新调用工具                 |
| Tier 2 | `[Content snipped - re-read if needed]` | 重新调用对应工具               |
| Tier 3 | `[Old result cleared]`                  | 重新调用工具（如果需要）           |
| Tier 4 | 模型生成的摘要                                 | **不可恢复**，但保留了关键决策和文件路径 |


---

## 11. 设计哲学

### 11.1 宁可让模型重做，也不让上下文溢出

```
重新执行 read_file:    ~5ms，0 成本
重新执行 grep_search:  ~50ms，0 成本
上下文溢出导致任务中断: 用户重新描述需求 + Agent 从零开始 = 几分钟 + $$$
```

### 11.2 零 API 开销优先

Tier 0-3 完全本地操作（修改 messages 数组），不产生任何 API 调用。只有 Tier 4 花费一次 API 调用，且是最后关头才触发。

### 11.3 模型是合作伙伴

不是在"欺骗"模型。每种压缩都通过占位符明确告知模型发生了什么：

- `[... budgeted: N chars truncated ...]` → "中间被裁了"
- `[Content snipped - re-read if needed]` → "数据被清了，你可以重新读"
- `[Old result cleared]` → "旧数据已过期"
- `[Previous conversation summary]` → "之前的对话被压缩成了摘要"

### 11.4 渐进式降级

```
正常运行 → 截断长结果 → 清理旧结果 → 缓存冷却激进清 → 全部压缩为摘要
```

就像操作系统内存管理：先回收页缓存 → 再回收不活跃页 → 最后 swap to disk。每一步都比上一步更激进，但只在真正需要时才触发。

---

## 附录：常量汇总


| 常量                     | 值         | 位置                 | 含义                      |
| ---------------------- | --------- | ------------------ | ----------------------- |
| `effectiveWindow`      | 180,000   | `agent.ts:402`     | 有效上下文大小 = 200K - 20K 余量 |
| Tier 0 阈值              | 30 KB     | `agent.ts:608`     | 超过此大小的结果写磁盘             |
| Tier 0 预览行数            | 200 行     | `agent.ts:618`     | 保留在上下文中的预览              |
| Tier 1 触发              | 50% 利用率   | `agent.ts:727`     | 开始截断大结果                 |
| Tier 1 宽松预算            | 30,000 字符 | `agent.ts:728`     | 50%~70% 时的单条结果上限        |
| Tier 1 紧凑预算            | 15,000 字符 | `agent.ts:728`     | >70% 时的单条结果上限           |
| `SNIP_THRESHOLD`       | 60%       | `agent.ts:243`     | Tier 2 触发利用率            |
| `SNIPPABLE_TOOLS`      | 4 种       | `agent.ts:225-230` | 可被 snip 的只读工具           |
| `KEEP_RECENT_RESULTS`  | 3         | `agent.ts:261`     | 始终保留最近 N 条不压缩           |
| `MICROCOMPACT_IDLE_MS` | 5 min     | `agent.ts:253`     | Tier 3 要求的空闲时间          |
| Tier 4 触发              | 85% 利用率   | `agent.ts:916`     | 触发 API 摘要压缩             |
| Tier 4 最短消息数           | 4 条       | `agent.ts:947`     | 低于此不压缩                  |
| 摘要 max_tokens          | 2,048     | `agent.ts:955`     | 摘要的最大输出长度               |


