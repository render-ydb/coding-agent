/**
 * Agent — 最小可用的 AI 编程助手 Agent 实现
 *
 * 本文件是整个 CLI 工具的核心引擎，实现了经典的 Tool-Use Agent Loop：
 *
 *   用户输入 → 发送给 LLM → LLM 返回文本或 tool_use → 执行工具
 *   → 将工具结果返回 LLM → 循环直到 LLM 不再调用工具
 *
 * 使用 Anthropic SDK（Messages API），通过 baseURL 支持代理/网关。
 *
 * 架构概览：
 * ┌──────────┐     ┌──────────┐     ┌──────────┐
 * │  用户    │ ──> │  Agent   │ ──> │ Anthropic│
 * │  (CLI)   │ <── │  Loop    │ <── │  API     │
 * └──────────┘     └────┬─────┘     └──────────┘
 *                       │
 *                  ┌────▼─────┐
 *                  │  Tools   │
 *                  │(tools/)  │
 *                  └──────────┘
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  toolDefinitions,
  executeTool,
  checkPermission,
  type PermissionMode,
} from './tools/index.js';

// Re-export PermissionMode 供 index.ts 使用
export type { PermissionMode } from './tools/index.js';

// ─────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────

/**
 * Agent 构造参数
 *
 * 由 CLI 入口（index.ts）解析 .env 和命令行参数后传入。
 */
export interface AgentOptions {
  /** API 密钥（用于认证） */
  apiKey: string;
  /** API 端点 URL（支持 Anthropic 官方或 litellm 等代理） */
  apiBaseUrl: string;
  /** 模型标识符（如 anthropic/claude-opus-4.6） */
  model: string;
  /** 权限模式，默认 "default" */
  permissionMode?: PermissionMode;
  /** 最大花费上限（美元），超过后自动停止 */
  maxCostUsd?: number;
  /** 最大工具执行轮次，超过后自动停止 */
  maxTurns?: number;
}

// ─────────────────────────────────────────────────────────
// System Prompt
// ─────────────────────────────────────────────────────────

/**
 * 构建系统提示词
 *
 * System Prompt 是 Agent 的"人格"和"规则手册"，告诉模型：
 * 1. 它是谁（编程助手）
 * 2. 应该如何行为（先读后改、使用工具、保持简洁）
 * 3. 当前环境信息（工作目录、日期、平台）
 *
 * 在 Anthropic API 中，system prompt 不在 messages 数组里，
 * 而是作为独立的 `system` 参数传入。这是和 OpenAI API 的关键区别之一。
 */
function buildSystemPrompt(): string {
  const cwd = process.cwd();
  const date = new Date().toISOString().split('T')[0];
  const platform = process.platform;

  return `You are a coding assistant CLI agent.
You help users with software engineering tasks: fixing bugs, writing code, refactoring, explaining code, and more.

# Rules
- Read files before editing them.
- Use dedicated tools (read_file, edit_file, etc.) instead of shell commands for file operations.
- Be concise. Lead with the answer, not the reasoning.
- Do NOT over-engineer. Only make changes that are directly requested.
- When calling multiple independent tools, call them in parallel.

# Environment
- Working directory: ${cwd}
- Date: ${date}
- Platform: ${platform}`;
}

// ─────────────────────────────────────────────────────────
// Agent 类
// ─────────────────────────────────────────────────────────

/**
 * Agent 类 —— 核心引擎
 *
 * 职责：
 * 1. 管理与 Anthropic API 的通信（流式请求/响应）
 * 2. 维护对话历史（messages 数组）
 * 3. 执行 Tool-Use Agent Loop（核心循环）
 * 4. 控制工具执行权限（委托给 tools/permissions）
 * 5. 追踪 token 用量和预算
 * 6. 支持中断（abort）
 *
 * 生命周期：
 * - 由 index.ts 的 main() 创建
 * - 通过 chat() 方法处理每一轮用户输入
 * - 通过 abort() 方法中断正在进行的请求
 */
export class Agent {
  /** Anthropic SDK 客户端实例 */
  private client: Anthropic;
  /** 模型标识符（如 anthropic/claude-opus-4.6） */
  private model: string;
  /** 系统提示词（构造时生成，整个会话不变） */
  private systemPrompt: string;
  /**
   * 对话历史
   *
   * Anthropic Messages API 的消息格式：
   * - { role: "user", content: string | ContentBlock[] }
   * - { role: "assistant", content: ContentBlock[] }
   *
   * 关键区别于 OpenAI：
   * 1. 没有 "system" role —— system prompt 通过独立参数传入
   * 2. tool_result 放在 user 消息中（而非 OpenAI 的独立 "tool" role）
   * 3. 消息必须严格交替：user → assistant → user → assistant ...
   *    工具执行完后的 tool_result 以 user 消息形式发送，天然维持交替
   */
  private messages: Anthropic.MessageParam[] = [];
  /** 当前权限模式 */
  private permissionMode: PermissionMode;

  // ── Token 统计 ──
  private totalInputTokens = 0;
  private totalOutputTokens = 0;

  // ── 预算控制 ──
  private maxCostUsd?: number;
  private maxTurns?: number;
  /** 当前已执行的工具轮次（每次有 tool_use 时 +1） */
  private currentTurns = 0;

  // ── 中断支持 ──
  /**
   * AbortController 用于中断正在进行的 API 请求。
   * 当用户按 Ctrl+C 时，REPL 调用 agent.abort()，
   * 进而 abort AbortController，使流式请求抛出 AbortError。
   * 为 null 表示 agent 当前空闲。
   */
  private abortController: AbortController | null = null;

  /**
   * 外部确认回调
   *
   * 当工具需要用户确认时调用。由 REPL 提供，复用已有的 readline 实例。
   * 不在 Agent 内部创建 readline，避免 Node.js 中多个 readline
   * 共享 stdin 导致的经典 bug（第二个 readline close 时会销毁第一个）。
   */
  private confirmFn?: (message: string) => Promise<boolean>;

  /**
   * 构造 Agent 实例
   *
   * baseURL 处理：Anthropic SDK 内部拼接 "/v1/messages"，
   * 所以去掉用户 URL 中已有的 "/v1" 避免重复。
   *
   * 认证处理：同时发送 x-api-key 和 Authorization: Bearer，
   * 确保兼容 Anthropic 官方 API 和 litellm 等代理。
   */
  constructor(options: AgentOptions) {
    const baseURL = options.apiBaseUrl.replace(/\/v1\/?$/, '');
    this.client = new Anthropic({
      apiKey: options.apiKey,
      baseURL,
      defaultHeaders: {
        Authorization: `Bearer ${options.apiKey}`,
      },
    });
    this.model = options.model;
    this.permissionMode = options.permissionMode || 'default';
    this.maxCostUsd = options.maxCostUsd;
    this.maxTurns = options.maxTurns;
    this.systemPrompt = buildSystemPrompt();
  }

  // ─── 公开方法 ────────────────────────────────────────

  /** agent 是否正在处理请求（用于 REPL 的 SIGINT 判断） */
  get isProcessing(): boolean {
    return this.abortController !== null;
  }

  /** 设置外部确认回调（由 REPL 在启动时注入） */
  setConfirmFn(fn: (message: string) => Promise<boolean>): void {
    this.confirmFn = fn;
  }

  /** 中断当前请求（由 REPL 的 SIGINT 处理器调用） */
  abort(): void {
    this.abortController?.abort();
  }

  /** 获取累计 token 用量 */
  getTokenUsage() {
    return { input: this.totalInputTokens, output: this.totalOutputTokens };
  }

  /** 清空对话历史（Anthropic 的 system prompt 不在 messages 中，直接清空即可） */
  clearHistory(): void {
    this.messages = [];
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
  }

  /** 显示当前 token 用量和估算费用 */
  showCost(): void {
    const costIn = (this.totalInputTokens / 1_000_000) * 3;
    const costOut = (this.totalOutputTokens / 1_000_000) * 15;
    const total = costIn + costOut;
    console.log(
      `\n  Tokens: ${this.totalInputTokens} in / ${this.totalOutputTokens} out` +
        `\n  Cost: ~$${total.toFixed(4)}` +
        (this.maxCostUsd ? ` / $${this.maxCostUsd} budget` : '') +
        (this.maxTurns
          ? ` | Turns: ${this.currentTurns}/${this.maxTurns}`
          : ''),
    );
  }

  // ─── 核心 Agent Loop ─────────────────────────────────

  /**
   * 处理一次用户输入，执行完整的 Agent Loop
   *
   * 流程：
   *   用户消息 → [调用 API → 收到响应 → 有 tool_use? → 执行工具 → 循环] → 输出文本
   *
   * Anthropic API 的消息流转：
   *   messages: [
   *     { role: "user",      content: "请读取 package.json" }
   *     { role: "assistant", content: [TextBlock, ToolUseBlock] }     ← API 返回
   *     { role: "user",      content: [ToolResultBlock] }            ← 我们构建
   *     { role: "assistant", content: [TextBlock] }                   ← API 返回
   *   ]
   */
  async chat(userMessage: string): Promise<void> {
    this.messages.push({ role: 'user', content: userMessage });
    this.abortController = new AbortController();

    try {
      while (true) {
        if (this.abortController.signal.aborted) break;

        // ── 调用 LLM（流式） ──
        const response = await this.callApi();

        // 记录 token 用量
        this.totalInputTokens += response.usage.input_tokens;
        this.totalOutputTokens += response.usage.output_tokens;

        // 保存 assistant 响应到对话历史
        this.messages.push({ role: 'assistant', content: response.content });

        // 提取 tool_use blocks
        const toolUses = response.content.filter(
          (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
        );

        // 无 tool_use → 对话结束
        if (toolUses.length === 0) break;

        // ── 执行工具 ──
        this.currentTurns++;
        if (this.isBudgetExceeded()) break;

        const toolResults: Anthropic.ToolResultBlockParam[] = [];

        for (const toolUse of toolUses) {
          // 工具执行过程中，用户停止，那么应该停止tool的使用
          if (this.abortController.signal.aborted) break;

          const input = toolUse.input as Record<string, any>;
          this.printToolCall(toolUse.name, input);

          // 权限检查
          const perm = checkPermission(
            toolUse.name,
            input,
            this.permissionMode,
          );
          if (perm === 'deny') {
            console.log(`  ✗ Denied in ${this.permissionMode} mode`);
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: 'Action denied by permission mode.',
            });
            continue;
          }
          if (perm === 'confirm') {
            const desc =
              toolUse.name === 'run_shell' ? input.command : input.file_path;
            const allowed = await this.confirm(`Allow: ${desc}`);
            if (!allowed) {
              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: 'User denied this action.',
              });
              continue;
            }
          }

          // 执行工具（executeTool 内部已包含结果截断）
          const result = executeTool(toolUse.name, input);
          this.printToolResult(toolUse.name, result);

          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: result,
          });
        }

        // 工具结果作为 user 消息加入（Anthropic API 规定）
        this.messages.push({ role: 'user', content: toolResults });
      }
    } finally {
      this.abortController = null;
    }
  }

  // ─── API 调用（流式）─────────────────────────────────

  /**
   * 调用 Anthropic Messages API（流式）
   *
   * 流式打印文本内容给用户，最终返回完整 Message 对象。
   */
  private async callApi(): Promise<Anthropic.Message> {
    const stream = this.client.messages.stream(
      {
        model: this.model,
        max_tokens: 16384,
        system: this.systemPrompt,
        tools: toolDefinitions,
        messages: this.messages,
      },
      { signal: this.abortController?.signal },
    );

    let firstText = true;
    // 这里显示的是给用户看的
    stream.on('text', (text: string) => {
      if (firstText) {
        process.stdout.write('\n');
        firstText = false;
      }
      process.stdout.write(text);
    });

    // 这里获取的是最终的响应，包含所有信息，进行下一次loop
    const finalMessage = await stream.finalMessage();
    if (!firstText) process.stdout.write('\n');

    return finalMessage;
  }

  // ─── 辅助方法 ────────────────────────────────────────

  private isBudgetExceeded(): boolean {
    if (this.maxTurns && this.currentTurns >= this.maxTurns) {
      console.log(`\n  ⚠ Turn limit reached (${this.maxTurns})`);
      return true;
    }
    if (this.maxCostUsd) {
      // Anthropic API 按 token 计费，费率以"每百万 token"为单位：
      //   输入: $3  / 1M tokens  →  每个 token = $0.000003
      //   输出: $15 / 1M tokens  →  每个 token = $0.000015
      // 这里用的是 Claude Sonnet 的参考价格，不同模型费率不同。
      //
      // 计算公式：
      //   总费用 = (输入 token 数 / 1,000,000) × 3 + (输出 token 数 / 1,000,000) × 15
      //
      // 例如：输入 50,000 tokens + 输出 10,000 tokens
      //   = (50000 / 1e6) × 3 + (10000 / 1e6) × 15
      //   = 0.15 + 0.15
      //   = $0.30
      const cost =
        (this.totalInputTokens / 1e6) * 3 + (this.totalOutputTokens / 1e6) * 15;
      if (cost >= this.maxCostUsd) {
        console.log(`\n  ⚠ Cost limit reached ($${cost.toFixed(4)})`);
        return true;
      }
    }
    return false;
  }

  private async confirm(message: string): Promise<boolean> {
    if (this.confirmFn) return this.confirmFn(message);
    console.log(`  ⚠ ${message} — auto-denied (no confirm handler)`);
    return false;
  }

  private printToolCall(name: string, input: Record<string, any>): void {
    let summary: string;

    switch (name) {
      case 'run_shell':
        summary = input.command;
        break;
      case 'read_file':
      case 'write_file':
      case 'edit_file':
        summary = input.file_path;
        break;
      case 'grep_search':
        summary = `"${input.pattern}"${input.path ? ` in ${input.path}` : ''}`;
        break;
      default:
        summary = JSON.stringify(input).slice(0, 80);
    }

    console.log(`\n  ▶ ${name}: ${summary}`);
  }

  private printToolResult(name: string, result: string): void {
    const lines = result.split('\n');
    const preview = lines.slice(0, 5).join('\n');
    const more = lines.length > 5 ? `\n    ... (${lines.length} lines)` : '';
    console.log(`  ◀ ${name}:\n    ${preview.replace(/\n/g, '\n    ')}${more}`);
  }
}
