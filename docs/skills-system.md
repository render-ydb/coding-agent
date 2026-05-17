# Skills 系统

Skills 是可复用的 AI 提示模板，存放在 `.claude/skills/<name>/SKILL.md` 中。可以理解为"AI 的 shell 脚本"——预定义好的指令集，可被用户通过 `/<name>` 命令调用，也可被模型通过 `skill` 工具自动调用。

## 目录结构

```
.claude/skills/
├── commit/
│   └── SKILL.md
├── explain/
│   └── SKILL.md
└── review/
    ├── SKILL.md
    └── checklist.md    ← 辅助文件，可通过 ${CLAUDE_SKILL_DIR} 引用
```

## SKILL.md 格式

```markdown
---
name: commit
description: Generate a conventional commit message
when-to-use: When the user asks to commit or save changes
allowed-tools: read_file, grep_search, run_shell
user-invocable: true
context: inline
---

Your prompt template here.

User request: $ARGUMENTS
```

### Frontmatter 字段

| 字段 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `name` | 否 | 目录名 | Skill 标识符，用于查找和调用 |
| `description` | 否 | `""` | 简短描述，显示在 `/skills` 列表和系统提示中 |
| `when-to-use` | 否 | — | 触发提示，告诉模型何时应该调用此 skill |
| `allowed-tools` | 否 | 全部工具 | fork 模式下子 Agent 可用的工具白名单 |
| `user-invocable` | 否 | `true` | 用户是否可通过 `/<name>` 直接调用 |
| `context` | 否 | `inline` | 执行模式：`inline` 或 `fork` |

### 模板变量

| 变量 | 说明 |
|------|------|
| `$ARGUMENTS` / `${ARGUMENTS}` | 替换为用户传入的参数字符串 |
| `${CLAUDE_SKILL_DIR}` | 替换为 SKILL.md 所在目录的绝对路径 |

`${CLAUDE_SKILL_DIR}` 允许 skill 引用同目录下的辅助文件：

```markdown
Read the checklist at ${CLAUDE_SKILL_DIR}/checklist.md and follow it.
```

## 发现优先级

Skills 从两个位置扫描，后者覆盖前者（同名时项目级优先）：

1. **用户级**：`~/.claude/skills/<name>/SKILL.md`（低优先级）
2. **项目级**：`<cwd>/.claude/skills/<name>/SKILL.md`（高优先级）

扫描结果在进程生命周期内缓存，不热更新。

## 执行模式

### Inline 模式（默认）

Skill 的 prompt 作为工具结果注入当前对话。模型看到 prompt 后按指令继续工作，共享当前上下文。

适合：简单指令、需要访问当前对话上下文的任务。

```
用户: /commit fix typos
  ↓
Agent 收到 skill prompt（作为 chat 输入）
  ↓
Agent 在当前上下文中按 prompt 执行
```

### Fork 模式

创建隔离的子 Agent，以 skill prompt 为系统提示独立执行。完成后仅将结果文本返回父 Agent。

适合：复杂独立任务、需要工具白名单限制的场景。

```
用户: /review src/agent.ts
  ↓
Agent 调用 skill 工具
  ↓
创建子 Agent（独立上下文，受限工具集）
  ↓
子 Agent 完成任务，返回结果文本
  ↓
结果作为 tool_result 回到父 Agent
```

子 Agent 特性：
- `isSubAgent: true`（跳过 MCP/memory/autoSave）
- 权限：父 Agent 在 plan 模式 → `plan`，其他 → `bypassPermissions`
- 工具：按 `allowed-tools` 过滤，默认排除 `agent` 工具防止递归

## 调用方式

### 1. 用户 REPL 命令

```
> /commit fix type errors in agent.ts
> /explain src/memory.ts
> /skills              ← 列出所有可用 skill
```

### 2. 模型自动调用（skill 工具）

模型通过系统提示中的 skill 列表和 `when-to-use` 提示，判断是否应调用某个 skill：

```json
{
  "name": "skill",
  "input": {
    "skill_name": "commit",
    "args": "fix type errors"
  }
}
```

## 架构图

```
┌─────────────────────────────────────────────────────────┐
│                    调用入口                               │
├─────────────┬───────────────────────────────────────────┤
│ REPL /<name>│           模型 skill 工具调用              │
│ (index.ts)  │           (agent.ts 拦截)                  │
└──────┬──────┴────────────────────┬──────────────────────┘
       │                           │
       ▼                           ▼
┌─────────────────────────────────────────────────────────┐
│              skills.ts — 核心模块                         │
├─────────────────────────────────────────────────────────┤
│ discoverSkills()     扫描目录，解析 SKILL.md，缓存       │
│ getSkillByName()     按名称查找                          │
│ executeSkill()       解析模板变量，返回 SkillResult       │
│ buildSkillPromptSection()  生成系统提示注入段             │
└──────┬──────────────────────────────────┬───────────────┘
       │                                  │
       ▼                                  ▼
┌──────────────┐                ┌─────────────────────────┐
│ frontmatter.ts│               │ agent.ts                 │
│ (YAML 解析)  │                │ executeSkillTool()       │
└──────────────┘                │ ├─ inline → 注入对话     │
                                │ └─ fork → 子 Agent       │
                                └─────────────────────────┘
```

## 文件清单

| 文件 | 职责 |
|------|------|
| `src/skills.ts` | 核心模块：发现、解析、执行、系统提示构建 |
| `src/tools/builtin/skill.ts` | `skill` 工具的 LLM schema 定义 |
| `src/tools/builtin/index.ts` | 注册 `skillTool` 到内置工具列表 |
| `src/agent.ts` | 工具拦截 + `executeSkillTool()` + 系统提示注入 |
| `src/index.ts` | REPL `/skills` 列表 + `/<name>` 命令调用 |
| `src/frontmatter.ts` | YAML frontmatter 解析（skills 和 memory 共用） |

## 关键设计决策

### 为什么 skill 工具在 agent.ts 中拦截而不是 executeTool() 中执行？

Fork 模式需要创建 Agent 实例（访问 client、model 等私有状态）。如果在 `tools/` 中实现会产生 `agent.ts ↔ tools/` 的循环依赖。与 `agent` 工具采用相同的拦截模式。

### 为什么不热更新 skill 缓存？

简化实现。进程重启即可加载新增的 skill。未来如需热更新可通过 `resetSkillCache()` + 文件监听实现。

### 为什么 inline 模式下 REPL 直接发送 prompt 而不走 skill 工具？

减少一次工具调用开销。inline 模式的本质就是"将指令注入对话"，直接 `agent.chat(prompt)` 比让模型先解析 tool_result 再执行更高效。

### `allowed-tools` 的解析策略

先尝试 JSON 数组（`["read_file", "grep_search"]`），失败则按逗号分割（`read_file, grep_search`）。兼容两种常见写法。
