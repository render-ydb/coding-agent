# Plan Mode 设计文档

> 基于 `src/agent.ts` 实际实现，版本：2026-05-16

---

## 1. 概述

### 1.1 什么是 Plan Mode

Plan Mode 是一种**只读规划阶段**，让 Agent 在动手修改代码之前先制定实施方案。

核心思路：**先想清楚再动手**。

```
普通模式:  用户提需求 → 模型直接改代码 → 可能改错 → 回滚重来
Plan 模式: 用户提需求 → 模型读代码 → 写计划文件 → 用户审批 → 再执行
```

### 1.2 解决什么问题

| 痛点 | Plan Mode 如何解决 |
|------|-------------------|
| 模型理解偏差，改了不该改的文件 | 先写计划让用户确认方向 |
| 复杂重构涉及多文件，改到一半发现路径不对 | 计划阶段就暴露设计问题 |
| 用户想了解模型的思路但不想它立刻执行 | 只读模式，不会产生任何副作用 |
| 大型任务需要分步执行 | 计划文件作为持久化的 todo list |

---

## 2. 快速开始

### 三种进入方式

**方式一：CLI 启动参数**

```bash
# 直接以 plan 模式启动
npx tsx src/index.ts --plan "重构 auth 模块"
```

**方式二：REPL 命令切换**

```bash
npx tsx src/index.ts
> /plan              # 进入 plan 模式
> 重构 buildSystemPrompt 函数
> ...                # 模型读代码、写计划
> /plan              # 再次输入退出 plan 模式
```

**方式三：模型自主调用工具**

模型在对话中判断任务复杂度后，可自行调用 `enter_plan_mode` 工具进入规划阶段。

---

## 3. 完整生命周期

### 3.1 流程图

```
┌──────────────────────────────────────────────────────────────┐
│                     Plan Mode 生命周期                        │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────────┐    ┌─────────────┐    ┌──────────────────────┐ │
│  │  进入    │ ──>│  只读探索    │ ──>│  写 plan 文件         │ │
│  │  Plan    │    │  read_file  │    │  write_file/edit_file│ │
│  │  Mode    │    │  list_files │    │  (仅限 plan 文件)     │ │
│  └─────────┘    │  grep_search│    └──────────┬───────────┘ │
│   ▲              └─────────────┘               │             │
│   │                                            ▼             │
│   │  ┌──────────────────┐    ┌─────────────────────────┐    │
│   │  │ 用户反馈          │    │ 调用 exit_plan_mode      │    │
│   └──│ (keep-planning)  │◄───│ 触发交互式审批            │    │
│      └──────────────────┘    └──────────┬──────────────┘    │
│                                         │                    │
│                              ┌──────────▼──────────┐        │
│                              │   用户选择 (4 选项)   │        │
│                              ├─────────────────────┤        │
│                              │ 1. 清空上下文并执行   │──┐     │
│                              │ 2. 保留上下文并执行   │──┤     │
│                              │ 3. 手动审批每个编辑   │──┼──>退出│
│                              │ 4. 继续规划 ─────────│──┘  plan│
│                              └─────────────────────┘   mode │
└──────────────────────────────────────────────────────────────┘
```

### 3.2 阶段详解

#### 阶段一：进入 Plan Mode

触发进入的三种路径（任选其一）：

| 路径 | 触发方式 | 代码位置 |
|------|---------|---------|
| CLI 参数 | `--plan` | `src/index.ts` parseArgs() |
| REPL 命令 | `/plan` | `src/index.ts` → `agent.togglePlanMode()` |
| 模型工具 | `enter_plan_mode` | `src/agent.ts` → `executePlanModeTool()` |

进入后发生的事情：
1. 保存当前权限模式到 `prePlanMode`（用于退出时恢复）
2. 权限模式切换为 `"plan"`
3. 生成 plan 文件路径：`~/.coding-agent/plans/plan-{sessionId}.md`
4. 系统提示追加 Plan Mode 指令段

#### 阶段二：只读探索 + 写计划

模型在此阶段：
- **可以做**：`read_file`、`list_files`、`grep_search`、写/编辑 plan 文件
- **不能做**：编辑任何其他文件、执行 shell 命令

plan 文件是模型唯一允许写入的文件，路径通过系统提示告知模型。

#### 阶段三：提交审批

模型调用 `exit_plan_mode` → Agent 读取 plan 文件内容 → 展示给用户 → 用户选择。

#### 阶段四：用户选择

详见下方「交互式审批」章节。

---

## 4. 权限模型

### 4.1 权限矩阵

`checkPermission()` 在 plan 模式下的完整判定逻辑：

```
checkPermission(toolName, input, mode="plan", planFilePath)
  │
  ├─ bypassPermissions?  → allow（优先级最高，但 plan 模式不会出现）
  ├─ 只读工具?            → allow
  │   read_file, list_files, grep_search
  ├─ plan mode 工具?      → allow
  │   enter_plan_mode, exit_plan_mode
  ├─ 编辑工具 + 目标是 plan 文件? → allow
  │   write_file(file_path == planFilePath)
  │   edit_file(file_path == planFilePath)
  ├─ 编辑工具 + 目标是其他文件?   → deny
  ├─ run_shell?           → deny
  └─ 其他?                → deny
```

### 4.2 权限矩阵表格

| 工具 | 目标 | plan 模式结果 |
|------|------|-------------|
| `read_file` | 任意文件 | ✅ allow |
| `list_files` | 任意目录 | ✅ allow |
| `grep_search` | 任意模式 | ✅ allow |
| `write_file` | plan 文件 | ✅ allow |
| `edit_file` | plan 文件 | ✅ allow |
| `write_file` | 其他文件 | ❌ deny |
| `edit_file` | 其他文件 | ❌ deny |
| `run_shell` | 任意命令 | ❌ deny |
| `enter_plan_mode` | — | ✅ allow |
| `exit_plan_mode` | — | ✅ allow |

**关键实现**：`src/tools/permissions.ts` 的 `checkPermission()` 函数接受第四个参数 `planFilePath?: string`，在 plan 模式下通过路径精确匹配来放行 plan 文件写入。

---

## 5. 交互式审批

当模型调用 `exit_plan_mode` 时，用户看到的界面：

```
  ━━━ Plan for Approval ━━━
  # 重构方案
  ## Context
  auth 模块职责不清...
  ## Steps
  1. 拆分 auth.ts 为 ...
  ...
  ━━━━━━━━━━━━━━━━━━━━━━━━

  Choose an option:
    1) Yes, clear context and execute — fresh start with auto-accept edits
    2) Yes, and execute              — keep context, auto-accept edits
    3) Yes, manually approve edits   — keep context, confirm each edit
    4) No, keep planning             — provide feedback to revise
  Enter choice (1-4):
```

### 四个选项对比

| 选项 | 上下文 | 权限模式 | 适用场景 |
|------|--------|---------|---------|
| 1. 清空上下文并执行 | 清空所有历史消息 | `acceptEdits`（自动批准编辑） | plan 很长、历史消息太多，希望干净开始 |
| 2. 保留上下文并执行 | 保留完整对话历史 | `acceptEdits`（自动批准编辑） | 简短对话，保持连贯性 |
| 3. 手动审批每个编辑 | 保留完整对话历史 | 恢复 `prePlanMode`（通常是 `default`） | 最安全，每个文件修改都需确认 |
| 4. 继续规划 | 保持 plan 模式 | 不变（仍是 `plan`） | 计划有问题，需要修改 |

### 选择 4 的反馈流程

```
  Enter choice (1-4): 4
  Feedback (what to change): 不要改 middleware，只改 auth.ts

  → 模型收到反馈文本
  → 修改 plan 文件
  → 再次调用 exit_plan_mode
  → 用户再次审批
  → ...（循环直到满意）
```

---

## 6. 状态管理

### 6.1 Agent 内部状态字段

```typescript
// src/agent.ts — Agent 类

private prePlanMode: PermissionMode | null = null;
// 进入 plan 前的权限模式，退出时用于恢复。
// null 表示非 plan 模式（或从 --plan 启动，无需恢复）。

private planFilePath: string | null = null;
// 当前 plan 文件绝对路径。
// 格式：~/.coding-agent/plans/plan-{sessionId}.md

private baseSystemPrompt: string;
// 不含 plan 指令的基础系统提示。
// 进出 plan 模式时用它作为基底拼接。

private contextCleared: boolean = false;
// "清空上下文并执行"的信号标志。
// 告诉工具执行循环如何注入 plan 内容。

private planApprovalFn?: (planContent: string) => Promise<{
  choice: "clear-and-execute" | "execute" | "manual-execute" | "keep-planning";
  feedback?: string;
}>;
// 审批回调，由 REPL 注入。
```

### 6.2 状态切换图

```
                    togglePlanMode()
                    enter_plan_mode
  ┌──────────┐     ──────────────>     ┌──────────┐
  │  normal  │                         │   plan   │
  │  mode    │     <──────────────     │   mode   │
  └──────────┘     togglePlanMode()    └──────────┘
                   exit_plan_mode
                   (审批通过后)

  状态保存:
    进入: prePlanMode = current mode
    退出: permissionMode = prePlanMode (或 acceptEdits)
```

### 6.3 系统提示的动态拼接

```
进入 plan 模式时:
  systemPrompt = baseSystemPrompt + buildPlanModePrompt()
  
退出 plan 模式时:
  systemPrompt = baseSystemPrompt
```

`buildPlanModePrompt()` 追加的内容包含：
- plan 模式激活声明
- plan 文件路径
- 工作流程指引（探索 → 设计 → 写计划 → 退出）
- 强制要求调用 `exit_plan_mode` 的指令

---

## 7. 上下文清理机制

### 7.1 为什么需要上下文清理

当用户选择"清空上下文并执行"（选项 1）时，plan 阶段的探索过程（大量 read_file 结果）不再有用，反而占用上下文窗口。清理后模型以 plan 内容为唯一上下文开始执行，效率更高。

### 7.2 contextCleared 标志传播

```
exit_plan_mode 被调用
  │
  ├─ 用户选择 1 (clear-and-execute)
  │   ├─ clearHistoryKeepSystem()  → messages = []
  │   ├─ contextCleared = true     → 设置标志
  │   └─ return plan 内容文本
  │
  ▼
chat() 工具执行循环检测 contextCleared
  │
  ├─ contextCleared == true?
  │   ├─ contextCleared = false    → 重置标志
  │   ├─ messages.push({ role: "user", content: result })
  │   │   → plan 内容作为新的 user 消息注入（而非 tool_result）
  │   ├─ contextBreak = true       → 跳出当前工具执行循环
  │   └─ 进入下一轮 API 调用
  │       → 模型看到：系统提示 + plan 内容（user 消息）
  │       → 开始执行 plan
  │
  └─ contextCleared == false?
      └─ 正常以 tool_result 加入 messages
```

### 7.3 为什么用 user 消息而不是 tool_result

`clearHistoryKeepSystem()` 清空了所有历史消息，包括之前的 `assistant` 消息中的 `tool_use` block。如果此时仍以 `tool_result` 格式注入，Anthropic API 会报错——因为找不到对应的 `tool_use`。

以 `user` 消息注入则不存在这个问题，模型会将 plan 内容当作用户的新指令来执行。

---

## 8. 涉及文件清单

| 文件 | 职责 | 关键函数/导出 |
|------|------|-------------|
| `src/tools/permissions.ts` | 权限矩阵，plan 文件白名单 | `checkPermission(tool, input, mode, planFilePath?)` |
| `src/tools/builtin/plan-mode.ts` | 工具定义（enter/exit） | `enterPlanMode`, `exitPlanMode` |
| `src/tools/builtin/index.ts` | 工具注册 | `builtinTools[]` |
| `src/agent.ts` | 核心状态管理、审批流程 | `togglePlanMode()`, `executePlanModeTool()`, `buildPlanModePrompt()`, `generatePlanFilePath()`, `clearHistoryKeepSystem()`, `setPlanApprovalFn()` |
| `src/index.ts` | REPL 接入、审批回调注入 | `/plan` 命令, `planApprovalFn` |
| `src/ui.ts` | 审批界面展示 | `printPlanForApproval()`, `printPlanApprovalOptions()` |

---

## 9. Plan 文件存储

```
~/.coding-agent/
  └── plans/
      ├── plan-a1b2c3d4.md    ← 会话 a1b2c3d4 的 plan
      ├── plan-e5f6g7h8.md    ← 会话 e5f6g7h8 的 plan
      └── ...
```

每个会话有独立的 plan 文件（以 `sessionId` 命名），避免并发冲突。
Plan 文件在会话结束后保留在磁盘上，可作为历史参考。
