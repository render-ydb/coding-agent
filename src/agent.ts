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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import {
  toolDefinitions,
  executeTool,
  checkPermission,
  CONCURRENCY_SAFE_TOOLS,
  type PermissionMode,
  type PermissionResult,
} from './tools/index.js';
import { McpManager } from './mcp.js';
import { saveSession, type SessionData } from './session.js';
import {
  startMemoryPrefetch,
  formatMemoriesForInjection,
  buildMemoryPromptSection,
  type MemoryPrefetch,
  type SideQueryFn,
} from './memory.js';
import {
  printToolCall,
  printToolResult,
  printAssistantText,
  printRetry,
  printInfo,
  printDenied,
  printBudgetExceeded,
  printConfirmFallback,
  printCost,
  printThinkingStart,
  printThinkingDelta,
  printThinkingEnd,
  printSubAgentStart,
  printSubAgentEnd,
  startSpinner,
  stopSpinner,
} from './ui.js';
import { getSubAgentConfig, type SubAgentType } from './subagent.js';

// Re-export PermissionMode 供 index.ts 使用
export type { PermissionMode } from './tools/index.js';

// ─────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────

/**
 * 流式完成的 tool_use block 的轻量表示
 *
 * 与 Anthropic.ToolUseBlock 不同，不要求 caller 等字段。
 * 在流式响应的 content_block_stop 事件中构造，仅携带
 * 提前执行所需的最小信息：id（关联 earlyExecutions）、
 * name（判断是否并发安全）、input（工具参数）。
 */
interface StreamedToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, any>;
}

/**
 * Agent 构造参数
 *
 * 由 CLI 入口（index.ts）解析 .env 和命令行参数后传入。
 * 子 Agent 通过 customSystemPrompt + customTools + isSubAgent 配置。
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
  /** 是否启用扩展思考（Extended Thinking），仅 Claude 4.x 支持 */
  thinking?: boolean;
  /** 最大花费上限（美元），超过后自动停止 */
  maxCostUsd?: number;
  /** 最大工具执行轮次，超过后自动停止 */
  maxTurns?: number;
  /** 子 Agent 自定义系统提示（覆盖默认 buildSystemPrompt） */
  customSystemPrompt?: string;
  /** 子 Agent 自定义工具集（覆盖默认 toolDefinitions） */
  customTools?: Anthropic.Tool[];
  /** 标记为子 Agent（跳过 MCP 初始化、memory prefetch、autoSave） */
  isSubAgent?: boolean;
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
// 重试（指数退避）
// ─────────────────────────────────────────────────────────

/**
 * 判断 API 错误是否可以安全重试
 *
 * 可重试的场景：
 * - HTTP 429: 请求限流（Rate Limit），等一段时间后通常恢复
 * - HTTP 503: 服务暂时不可用（Service Unavailable）
 * - HTTP 529: Anthropic 自定义状态码，表示 API 过载
 * - ECONNRESET: TCP 连接被对端重置（通常是网络抖动）
 * - ETIMEDOUT: 连接超时（DNS 或 TCP 握手超时）
 * - "overloaded": Anthropic API 返回的过载错误消息
 *
 * 不可重试的场景（会直接抛出）：
 * - HTTP 400: 请求格式错误（重试也不会成功）
 * - HTTP 401/403: 认证失败（密钥问题）
 * - HTTP 404: 模型不存在
 * - 编程错误（TypeError 等）
 */
function isRetryable(error: any): boolean {
  const status = error?.status || error?.statusCode;
  if ([429, 503, 529].includes(status)) return true;
  if (error?.code === 'ECONNRESET' || error?.code === 'ETIMEDOUT') return true;
  if (error?.message?.includes('overloaded')) return true;
  return false;
}

/**
 * 带指数退避的重试包装器
 *
 * 工作原理：
 * 1. 执行传入的异步函数 fn
 * 2. 如果成功，直接返回结果
 * 3. 如果失败且可重试，等待一段时间后重试
 * 4. 等待时间按指数增长：1s → 2s → 4s（加随机抖动防止惊群效应）
 * 5. 最多重试 maxRetries 次（默认 3 次），之后抛出原始错误
 *
 * 指数退避公式：
 *   delay = min(1000 * 2^attempt, 30000) + random(0, 1000)
 *
 *   attempt=0: ~1s,  attempt=1: ~2s,  attempt=2: ~4s
 *
 * 惊群效应（Thundering Herd）：
 *   当多个客户端同时收到 429 后如果都在完全相同的时间重试，
 *   服务器会再次过载。加随机抖动（jitter）让重试时间分散开。
 *
 * AbortSignal 支持：
 *   如果外部发出中断信号（用户按 Ctrl+C），立即终止重试循环。
 *
 * @param fn         要执行的异步函数，接收 AbortSignal 参数
 * @param signal     外部中断信号（来自 AbortController）
 * @param maxRetries 最大重试次数，默认 3
 * @returns          fn 的返回值
 */
async function withRetry<T>(
  fn: (signal?: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
  maxRetries = 3,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(signal);
    } catch (error: any) {
      // 用户主动中断 → 立即抛出，不重试
      if (signal?.aborted) throw error;
      // 超过重试次数或不可重试的错误 → 直接抛出
      if (attempt >= maxRetries || !isRetryable(error)) throw error;
      // 计算退避时间：指数增长 + 随机抖动
      const delay =
        Math.min(1000 * Math.pow(2, attempt), 30000) + Math.random() * 1000;
      const reason = error?.status
        ? `HTTP ${error.status}`
        : error?.code || 'network error';
      printRetry(attempt + 1, maxRetries, reason);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// ─────────────────────────────────────────────────────────
// 模型上下文窗口
// ─────────────────────────────────────────────────────────

/**
 * 各模型的上下文窗口大小（单位：token）
 *
 * 上下文窗口 = 模型单次请求能处理的最大 token 总量（输入 + 输出）。
 * 当对话历史接近此限制时，需要压缩（compact）以避免 API 报错。
 *
 * Claude 4.x 系列统一为 200K token。
 * 如果模型不在列表中，默认使用 200K（安全保守值）。
 */
const MODEL_CONTEXT: Record<string, number> = {
  'claude-opus-4-6': 200000,
  'claude-sonnet-4-6': 200000,
  'claude-haiku-4-5-20251001': 200000,
  'claude-opus-4-20250514': 200000,
  'claude-sonnet-4-20250514': 200000,
};

/**
 * 根据模型名称查找上下文窗口大小
 *
 * 使用 includes 匹配而非精确匹配，因为实际使用时模型名可能带有
 * 前缀（如 "anthropic/claude-sonnet-4-6"）或版本后缀。
 */
function getContextWindow(model: string): number {
  for (const [key, value] of Object.entries(MODEL_CONTEXT)) {
    if (model.includes(key)) return value;
  }
  return 200000;
}

// ─────────────────────────────────────────────────────────
// Extended Thinking 支持
// ─────────────────────────────────────────────────────────

/**
 * 判断模型是否支持 Extended Thinking
 *
 * Extended Thinking 是 Anthropic Claude 4.x 系列的功能，
 * 允许模型在生成最终回答前进行"思考"（Chain of Thought），
 * 思考过程会以 thinking 类型的 content block 流式返回。
 *
 * 支持条件：
 * - 必须是 Claude 品牌模型（包含 "claude" 关键字）
 * - 必须是 4.x 或更高版本（排除 3.x 系列）
 * - 非 Claude 模型（如 GPT）一律不支持
 */
function modelSupportsThinking(model: string): boolean {
  const m = model.toLowerCase();
  // 排除 Claude 3.x 系列（3-5 = 3.5, 3-7 = 3.7 等旧命名）
  if (m.includes('claude-3-') || m.includes('3-5-') || m.includes('3-7-'))
    return false;
  // Claude 4.x 系列的 opus/sonnet/haiku 都支持
  if (
    m.includes('claude') &&
    (m.includes('opus') || m.includes('sonnet') || m.includes('haiku'))
  )
    return true;
  return false;
}

/**
 * 判断模型是否支持 Adaptive Thinking（自适应思考）
 *
 * Adaptive Thinking 是 4.6 版本引入的增强特性：
 * 模型会根据问题复杂度自动决定思考的深度和长度，
 * 简单问题可能跳过思考，复杂问题则深入推理。
 *
 * 目前仅 opus-4-6 和 sonnet-4-6 支持。
 */
function modelSupportsAdaptiveThinking(model: string): boolean {
  const m = model.toLowerCase();
  return m.includes('opus-4-6') || m.includes('sonnet-4-6');
}

/**
 * 根据模型返回最大输出 token 数
 *
 * 当启用 Extended Thinking 时，max_tokens 需要足够大以容纳
 * 思考内容 + 最终回答。各模型的限制不同：
 *
 * - opus-4-6:   64,000 tokens（最强推理能力，需要更大空间）
 * - sonnet-4-6: 32,000 tokens
 * - 其他 4.x:   32,000 tokens
 * - 未知模型:   16,384 tokens（安全保守值）
 *
 * thinking.budget_tokens 必须严格小于 max_tokens（API 要求），
 * 因此实际设置为 getMaxOutputTokens() - 1。
 */
function getMaxOutputTokens(model: string): number {
  const m = model.toLowerCase();
  if (m.includes('opus-4-6')) return 64000;
  if (m.includes('sonnet-4-6')) return 32000;
  if (m.includes('opus-4') || m.includes('sonnet-4') || m.includes('haiku-4'))
    return 32000;
  return 16384;
}

// ─────────────────────────────────────────────────────────
// 多层压缩常量
// ─────────────────────────────────────────────────────────

/**
 * 可被 snip（裁剪）的工具集合
 *
 * 这些工具的结果通常较大且可以重新获取（re-read），
 * 因此在上下文紧张时可以安全地用占位符替换。
 * 模型看到占位符后会重新调用工具获取最新内容。
 */
const SNIPPABLE_TOOLS = new Set([
  'read_file',
  'grep_search',
  'list_files',
  'run_shell',
]);

/** snip 占位符文本，模型看到后知道可以重新读取 */
const SNIP_PLACEHOLDER = '[Content snipped - re-read if needed]';

/**
 * Tier 2 触发阈值：上下文利用率超过 60% 时开始 snip 旧结果
 *
 * 选择 60% 的原因：
 * - 50% 时 Tier 1（budgeting）已在截断单个大结果
 * - 60% 时说明有很多工具结果积累，需要更激进的策略
 * - 留出足够余量给后续 turn 的输入输出
 */
const SNIP_THRESHOLD = 0.6;

/**
 * Microcompact 冷却时间：5 分钟
 *
 * Anthropic 的 prompt cache TTL 为 5 分钟。
 * 超过此时间后缓存失效，下次请求会重新计算整个上下文。
 * 此时激进清理旧结果不会增加额外成本（因为缓存本来就要重建），
 * 反而能减小上下文体积、加速后续请求。
 */
const MICROCOMPACT_IDLE_MS = 5 * 60 * 1000;

/**
 * 保留最近 N 个工具结果不被压缩
 *
 * 最近的结果通常与当前任务最相关，应始终保留。
 * 3 是经验值：足够让模型回顾最近操作，又不占太多上下文。
 */
const KEEP_RECENT_RESULTS = 3;

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
  /** 用户是否请求了扩展思考（--thinking 开关） */
  private thinking: boolean;
  /**
   * 最终解析后的思考模式
   *
   * 三种状态：
   * - "disabled": 不使用思考（默认，或模型不支持）
   * - "enabled":  启用思考（Claude 4.x 非 4.6 版本）
   * - "adaptive": 自适应思考（Claude 4.6 系列，模型自动决定思考深度）
   *
   * 由 resolveThinkingMode() 在构造时计算，综合用户意图和模型能力。
   */
  private thinkingMode: 'adaptive' | 'enabled' | 'disabled';

  // ── Token 统计 ──
  /** 累计输入 token 数（所有 API 调用的 input_tokens 之和），用于费用估算 */
  private totalInputTokens = 0;
  /** 累计输出 token 数（所有 API 调用的 output_tokens 之和），用于费用估算 */
  private totalOutputTokens = 0;

  // ── 预算控制 ──
  /** 最大花费上限（美元），超过后 Agent Loop 自动停止。由 CLI --max-cost 参数设置 */
  private maxCostUsd?: number;
  /** 最大工具执行轮次，超过后 Agent Loop 自动停止。由 CLI --max-turns 参数设置 */
  private maxTurns?: number;
  /** 当前已执行的工具轮次（每次 assistant 返回 tool_use 时 +1，纯文本响应不计数） */
  private currentTurns = 0;

  // ── 上下文压缩状态 ──
  /**
   * 上一次 API 调用返回的输入 token 数
   *
   * 来自 response.usage.input_tokens，反映当前对话历史的实际 token 大小。
   * 用于计算上下文利用率 = lastInputTokenCount / effectiveWindow，
   * 各层压缩根据此利用率决定是否触发。
   *
   * 注意：这不是累计值，而是最近一次调用的快照值。
   * 每次 API 调用后更新，compactConversation() 后重置为 0。
   */
  private lastInputTokenCount = 0;
  /**
   * 上一次 API 调用的时间戳（Date.now() 毫秒值）
   *
   * 用于 Tier 3（microcompact）判断 prompt cache 是否已冷却。
   * 如果 Date.now() - lastApiCallTime > 5 分钟，说明缓存已失效，
   * 可以激进清理旧结果而不增加额外成本。
   *
   * 初始值为 0，表示尚未进行过 API 调用。
   */
  private lastApiCallTime = 0;
  /**
   * 有效上下文窗口大小（token）
   *
   * = getContextWindow(model) - 20000
   *
   * 比模型的实际上下文窗口小 20,000 token，作为安全余量。
   * 这 20K 预留给：
   * - system prompt（约 500 token）
   * - 工具定义（约 3000 token，6 个工具）
   * - 模型的输出空间（max_tokens=16384）
   * - API 请求/响应的元数据开销
   *
   * 例如：Claude Sonnet 4.6 的窗口为 200K
   * → effectiveWindow = 200000 - 20000 = 180000
   * → 上下文利用率 85% 时触发 auto-compact = 180000 × 0.85 = 153000 token
   */
  private effectiveWindow: number;

  // ── 中断支持 ──
  /**
   * AbortController 用于中断正在进行的 API 请求。
   * 当用户按 Ctrl+C 时，REPL 调用 agent.abort()，
   * 进而 abort AbortController，使流式请求抛出 AbortError。
   * 为 null 表示 agent 当前空闲。
   */
  private abortController: AbortController | null = null;

  // ── Plan Mode 状态 ──
  /**
   * 进入 plan 模式前的权限模式
   *
   * 用于在退出 plan 模式时恢复原始权限。
   * 为 null 表示当前不在 plan 模式中（或从 CLI --plan 启动，无需恢复）。
   */
  private prePlanMode: PermissionMode | null = null;
  /**
   * 当前 plan 文件的绝对路径
   *
   * plan 模式下模型唯一允许写入的文件。
   * 路径格式：~/.coding-agent/plans/plan-{sessionId}.md
   * 为 null 表示未处于 plan 模式。
   */
  private planFilePath: string | null = null;
  /**
   * 不含 plan 模式附加内容的基础系统提示
   *
   * 构造时保存一份 buildSystemPrompt() 的原始结果。
   * 进出 plan 模式时用它作为基底，动态拼接或移除 plan 提示段。
   */
  private baseSystemPrompt: string;
  /**
   * 标记上下文已被清理（plan 审批 clear-and-execute 选项）
   *
   * 当用户选择"清空上下文并执行"时，消息历史被清空，
   * 但当前工具执行循环仍在进行中。此标志告诉循环：
   * 将 executePlanModeTool 的返回值以 user 消息注入而非 tool_result，
   * 然后跳出当前循环，让模型以全新上下文开始执行 plan。
   */
  private contextCleared = false;

  // ── Permission 会话白名单 ──
  /**
   * 已确认路径/命令的白名单
   *
   * 当用户在 confirm 模式下批准某个操作时，将操作描述（文件路径或命令）
   * 加入此集合。后续对同一路径/命令的操作自动放行，不再重复询问。
   *
   * 生命周期与 Agent 实例相同，不跨会话持久化。
   * 这避免了用户在同一文件上多次编辑时被反复询问的烦扰。
   */
  private confirmedPaths: Set<string> = new Set();

  // ── Read-before-edit 追踪 ──
  /**
   * 文件读取状态追踪（绝对路径 → mtimeMs）
   *
   * 记录每个被 read_file 读取过的文件的最后修改时间戳。
   * 在 write_file / edit_file 执行前做两层校验：
   * 1. 文件是否曾被读取（防止模型盲写未读取的文件）
   * 2. 文件在读取后是否被外部修改（防止覆盖用户或其他进程的改动）
   *
   * 生命周期与 Agent 实例相同，不跨会话持久化。
   * 新建文件（不存在于磁盘）跳过检查。
   */
  private readFileState: Map<string, number> = new Map();

  // ── Memory 语义召回 ──
  /**
   * 已在本会话中展示过的记忆文件路径集合（去重用）
   *
   * 同一条记忆在同一会话中只注入一次，避免重复占用上下文。
   * 使用文件绝对路径作为唯一标识。
   * 生命周期与 Agent 实例相同，不跨会话持久化。
   */
  private alreadySurfacedMemories: Set<string> = new Set();
  /**
   * 本会话已注入的记忆内容累计字节数
   *
   * 用于预算控制：当累计超过 MAX_SESSION_MEMORY_BYTES (60KB) 时，
   * startMemoryPrefetch() 返回 null，停止召回新记忆。
   * 避免记忆占据过多上下文空间。
   */
  private sessionMemoryBytes = 0;
  /**
   * 当前正在进行的记忆预取句柄
   *
   * 提升为实例字段（而非 chat() 局部变量），原因：
   * 1. 在 finally 块中需要检查并清理未消费的预取
   * 2. 避免模型直接返回纯文本（无 tool_use）时预取的 sideQuery
   *    在后台白白完成却无人消费的资源浪费
   *
   * 生命周期：
   * - chat() 入口处创建（可能为 null，门控未通过时）
   * - while 循环内消费（settled 后注入并置 consumed=true）
   * - finally 中清理（未消费时通过 abort 取消 sideQuery）
   */
  private memoryPrefetch: MemoryPrefetch | null = null;

  // ── MCP 集成 ──
  /**
   * MCP 管理器实例
   *
   * 负责外部 MCP 服务器的连接、工具发现和调用路由。
   * 在 Agent 构造时创建（轻量，不做 I/O），
   * 实际连接在首次 chat() 调用时懒执行。
   */
  private mcpManager = new McpManager();
  /**
   * MCP 初始化标志
   *
   * 确保 loadAndConnect() 只在首次 chat() 调用时执行一次。
   * 即使初始化失败（try/catch），也会置为 true 避免重复尝试。
   */
  private mcpInitialized = false;
  /**
   * MCP 工具定义缓存
   *
   * 服务器连接后缓存所有 MCP 工具的 Anthropic Tool 定义，
   * 在每次 callApi() 时与内置工具合并发送给模型。
   * 未配置 MCP 服务器时为空数组，不影响现有行为。
   */
  private mcpTools: Anthropic.Tool[] = [];

  /**
   * Plan 审批回调
   *
   * 由 REPL 注入（setPlanApprovalFn），在模型调用 exit_plan_mode 时触发。
   * 展示 plan 内容并提供四个选项供用户选择。
   * 与 confirmFn 类似，避免在 Agent 内部创建 readline 实例。
   */
  private planApprovalFn?: (planContent: string) => Promise<{
    choice:
      | 'clear-and-execute'
      | 'execute'
      | 'manual-execute'
      | 'keep-planning';
    feedback?: string;
  }>;

  // ── Sub-Agent 支持 ──
  /**
   * 标记当前实例是否为子 Agent
   *
   * 子 Agent 的行为差异：
   * - 跳过 MCP 服务器初始化（使用父 Agent 传入的工具集）
   * - 跳过 memory prefetch（不需要独立的记忆召回）
   * - 跳过 autoSave（不需要持久化短暂的子任务会话）
   * - 跳过 spinner（避免与父 Agent 的输出冲突）
   * - 文本输出到 outputBuffer 而非 stdout
   */
  private isSubAgent: boolean;
  /**
   * 子 Agent 的文本捕获缓冲区
   *
   * 非 null 时，emitText() 将文本 push 到此数组而非 printAssistantText()。
   * 在 runOnce() 中设置为 []，完成后 join 为最终文本结果。
   * 正常模式（非子 Agent）下始终为 null。
   */
  private outputBuffer: string[] | null = null;
  /**
   * 子 Agent 的自定义工具集
   *
   * 非 null 时覆盖默认的 toolDefinitions，
   * 用于限制子 Agent 可使用的工具（如 explore 类型只有只读工具）。
   * 正常模式下为 null，使用全局 toolDefinitions。
   */
  private customTools: Anthropic.Tool[] | null = null;

  // ── 会话持久化 ──
  /**
   * 会话唯一标识符（8 字符 UUID 前缀）
   *
   * 用作会话文件名：~/.coding-agent/sessions/{sessionId}.json
   * 取 UUID 前 8 位是为了生成足够唯一且人类可读的 ID。
   * 在 restoreSession() 中会被覆盖为恢复会话的原始 ID，
   * 这样后续 autoSave() 会更新同一个文件而非创建新文件。
   */
  private sessionId = randomUUID().slice(0, 8);
  /**
   * 会话创建时间（ISO 8601 格式）
   *
   * 用于 getLatestSessionId() 排序，找到最近的会话。
   * 与 sessionId 一样，restoreSession() 时会恢复为原始值。
   */
  private sessionStartTime = new Date().toISOString();

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
    this.thinking = options.thinking || false;
    this.thinkingMode = this.resolveThinkingMode();
    this.maxCostUsd = options.maxCostUsd;
    this.maxTurns = options.maxTurns;
    this.effectiveWindow = getContextWindow(this.model) - 20000;
    this.isSubAgent = options.isSubAgent || false;
    this.customTools = options.customTools || null;

    // 子 Agent 使用自定义系统提示，不包含 memory 指令和 plan 模式
    // 父 Agent 使用默认系统提示 + memory 指令，可选追加 plan 模式指令
    if (this.isSubAgent && options.customSystemPrompt) {
      this.baseSystemPrompt = options.customSystemPrompt;
      this.systemPrompt = this.baseSystemPrompt;
    } else {
      this.baseSystemPrompt =
        buildSystemPrompt() + '\n\n' + buildMemoryPromptSection();

      if (this.permissionMode === 'plan') {
        this.planFilePath = this.generatePlanFilePath();
        this.systemPrompt = this.baseSystemPrompt + this.buildPlanModePrompt();
      } else {
        this.systemPrompt = this.baseSystemPrompt;
      }
    }
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

  /**
   * 设置 Plan 审批回调（由 REPL 在启动时注入）
   *
   * 当模型调用 exit_plan_mode 时，Agent 通过此回调
   * 将 plan 内容展示给用户并收集审批结果。
   */
  setPlanApprovalFn(
    fn: (planContent: string) => Promise<{
      choice:
        | 'clear-and-execute'
        | 'execute'
        | 'manual-execute'
        | 'keep-planning';
      feedback?: string;
    }>,
  ): void {
    this.planApprovalFn = fn;
  }

  /**
   * 切换 Plan Mode（由 REPL /plan 命令调用）
   *
   * 行为：
   * - 当前非 plan 模式 → 进入 plan 模式：
   *   1. 保存当前 permissionMode 到 prePlanMode
   *   2. 切换到 "plan" 模式
   *   3. 生成 plan 文件路径
   *   4. 追加 plan 模式系统提示
   *
   * - 当前 plan 模式 → 退出 plan 模式：
   *   1. 恢复 prePlanMode
   *   2. 清除 planFilePath
   *   3. 恢复原始系统提示
   *
   * @returns 切换后的模式名称（供 REPL 展示）
   */
  togglePlanMode(): string {
    if (this.permissionMode === 'plan') {
      this.permissionMode = this.prePlanMode || 'default';
      this.prePlanMode = null;
      this.planFilePath = null;
      this.systemPrompt = this.baseSystemPrompt;
      printInfo(`Exited plan mode → ${this.permissionMode} mode`);
      return this.permissionMode;
    } else {
      this.prePlanMode = this.permissionMode;
      this.permissionMode = 'plan';
      this.planFilePath = this.generatePlanFilePath();
      this.systemPrompt = this.baseSystemPrompt + this.buildPlanModePrompt();
      printInfo(`Entered plan mode. Plan file: ${this.planFilePath}`);
      return 'plan';
    }
  }

  /** 获取当前权限模式（供 REPL 展示） */
  getPermissionMode(): string {
    return this.permissionMode;
  }

  /**
   * 根据用户意图和模型能力解析最终的思考模式
   *
   * 优先级链：
   * 1. 用户未请求 thinking（--thinking） → disabled
   * 2. 模型不支持 thinking（非 Claude 4.x） → disabled
   * 3. 模型支持 adaptive（4.6 系列） → adaptive
   * 4. 模型支持但非 adaptive → enabled
   */
  private resolveThinkingMode(): 'adaptive' | 'enabled' | 'disabled' {
    if (!this.thinking) return 'disabled';
    if (!modelSupportsThinking(this.model)) return 'disabled';
    if (modelSupportsAdaptiveThinking(this.model)) return 'adaptive';
    return 'enabled';
  }

  /**
   * 构建 sideQuery 函数用于记忆语义召回
   *
   * sideQuery 是一个轻量的 LLM 调用，使用与主对话相同的模型和客户端实例，
   * 但以极小的 max_tokens (256) 运行，仅用于从记忆清单中选择相关文件。
   *
   * 返回的函数签名与 SideQueryFn 类型匹配。
   *
   * 为什么不用流式？
   * - 响应极短（<256 tokens），流式开销不值得
   * - 非流式调用更简单可靠
   * - 这是后台异步调用，不需要向用户展示中间结果
   */
  private buildSideQuery(): SideQueryFn {
    const client = this.client;
    const model = this.model;
    return async (
      system: string,
      userMessage: string,
      signal?: AbortSignal,
    ): Promise<string> => {
      const resp = await client.messages.create(
        {
          model,
          max_tokens: 256,
          system,
          messages: [{ role: 'user', content: userMessage }],
        },
        { signal },
      );
      return resp.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
    };
  }

  /** 中断当前请求（由 REPL 的 SIGINT 处理器调用） */
  abort(): void {
    this.abortController?.abort();
  }

  /**
   * 文本输出路由 —— 根据模式决定输出目标
   *
   * 子 Agent 模式（outputBuffer !== null）：文本存入缓冲区，
   * 由 runOnce() 在执行完成后一次性收集。
   * 正常模式：直接通过 printAssistantText() 输出到 stdout。
   *
   * 之所以不在每个输出点做 if 判断，而是抽取为独立方法：
   * 1. 减少重复代码（callApi 中有多处文本输出）
   * 2. 未来如需增加输出目标（如日志文件），只需修改此处
   */
  private emitText(text: string): void {
    if (this.outputBuffer) {
      this.outputBuffer.push(text);
    } else {
      printAssistantText(text);
    }
  }

  /**
   * 子 Agent 单次执行入口
   *
   * 设置输出捕获缓冲区，执行一次完整的 chat 循环，
   * 然后收集缓冲区中的所有文本作为结果返回。
   *
   * 返回值包含文本结果和增量 token 用量，
   * 父 Agent 据此累加自己的 token 统计。
   *
   * @param prompt 任务指令（作为 user 消息发送给子 Agent）
   * @returns      { text: 子 Agent 的输出文本, tokens: { input, output } }
   */
  async runOnce(
    prompt: string,
  ): Promise<{ text: string; tokens: { input: number; output: number } }> {
    this.outputBuffer = [];
    const prevInput = this.totalInputTokens;
    const prevOutput = this.totalOutputTokens;

    await this.chat(prompt);

    const text = this.outputBuffer.join('');
    this.outputBuffer = null;

    return {
      text,
      tokens: {
        input: this.totalInputTokens - prevInput,
        output: this.totalOutputTokens - prevOutput,
      },
    };
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
    this.lastInputTokenCount = 0;
    this.lastApiCallTime = 0;
    // 重置记忆追踪状态（新对话不应受旧会话的去重/预算限制）
    this.alreadySurfacedMemories.clear();
    this.sessionMemoryBytes = 0;
  }

  /**
   * 获取当前会话 ID
   *
   * 由 REPL 用于在 Config 信息中展示会话标识，
   * 方便用户知道当前是哪个会话（对应磁盘上的 {id}.json 文件）。
   */
  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * 恢复之前保存的会话
   *
   * 由 CLI 的 --resume 逻辑调用，将磁盘上的 SessionData 注入到 Agent 中。
   *
   * 恢复的内容：
   * - messages: 完整的对话历史（类型断言为 Anthropic.MessageParam[]）
   * - sessionId: 覆盖当前 ID，使后续 autoSave() 更新同一文件
   * - sessionStartTime: 保持原始时间戳，用于排序一致性
   *
   * 不恢复的内容（by design）：
   * - totalInputTokens / totalOutputTokens: 从零开始计费，/cost 只显示恢复后的用量
   * - currentTurns: 轮次计数重新开始
   * - lastInputTokenCount: 首次 API 调用后会被正确设置
   * - lastApiCallTime: 设为 0 表示"刚启动"，不会误触发 microcompact
   *
   * 这意味着恢复后的第一次 API 调用，模型会收到完整的历史消息，
   * API 返回的 usage.input_tokens 会反映这些历史消息的实际 token 数，
   * 从而让压缩管道能正确判断上下文利用率。
   *
   * @param data 从 loadSession() 获取的完整会话数据
   */
  restoreSession(data: SessionData): void {
    this.messages = data.messages as Anthropic.MessageParam[];
    this.sessionId = data.metadata.id;
    this.sessionStartTime = data.metadata.startTime;
    printInfo(
      `Session restored: ${data.metadata.id} (${data.metadata.messageCount} messages)`,
    );
  }

  /** 显示当前 token 用量和估算费用 */
  showCost(): void {
    printCost(this.totalInputTokens, this.totalOutputTokens, {
      maxCostUsd: this.maxCostUsd,
      maxTurns: this.maxTurns,
      currentTurns: this.currentTurns,
    });
  }

  /** 手动触发对话压缩（由 REPL /compact 命令调用） */
  async compact(): Promise<void> {
    await this.compactConversation();
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
      // 懒初始化 MCP 服务器连接（仅首次 chat 调用时执行）
      // 子 Agent 跳过 MCP 初始化：使用父 Agent 传入的 customTools
      if (!this.mcpInitialized && !this.isSubAgent) {
        this.mcpInitialized = true;
        try {
          await this.mcpManager.loadAndConnect();
          this.mcpTools =
            this.mcpManager.getToolDefinitions() as Anthropic.Tool[];
        } catch (err: any) {
          console.error(`[mcp] Initialization failed: ${err.message}`);
        }
      }

      await this.checkAndCompact();

      // ── 异步启动记忆预取（非阻塞，每个用户轮次触发一次）──
      // 子 Agent 跳过 memory prefetch：无需独立的记忆召回
      if (!this.isSubAgent) {
        const sideQuery = this.buildSideQuery();
        this.memoryPrefetch = startMemoryPrefetch(
          userMessage,
          sideQuery,
          this.alreadySurfacedMemories,
          this.sessionMemoryBytes,
          this.abortController.signal,
        );
      }

      while (true) {
        if (this.abortController.signal.aborted) break;

        this.runCompressionPipeline();

        // ── 消费记忆预取结果（非阻塞轮询）──
        // 每次循环迭代都检查，确保模型尽快看到召回的记忆。
        // 记忆内容追加到最后一条 user 消息中，
        // 避免连续 user 消息违反 Anthropic API 的交替规则。
        if (
          this.memoryPrefetch &&
          this.memoryPrefetch.settled &&
          !this.memoryPrefetch.consumed
        ) {
          this.memoryPrefetch.consumed = true;
          try {
            const memories = await this.memoryPrefetch.promise;
            if (memories.length > 0) {
              const injectionText = formatMemoriesForInjection(memories);
              const last = this.messages[this.messages.length - 1];
              if (last && last.role === 'user') {
                if (typeof last.content === 'string') {
                  last.content = last.content + '\n\n' + injectionText;
                } else if (Array.isArray(last.content)) {
                  (last.content as any[]).push({
                    type: 'text',
                    text: injectionText,
                  });
                }
              } else {
                this.messages.push({ role: 'user', content: injectionText });
              }
              for (const m of memories) {
                this.alreadySurfacedMemories.add(m.path);
                this.sessionMemoryBytes += Buffer.byteLength(m.content);
              }
            }
          } catch {
            /* 预取错误已在 memory.ts 中记录日志 */
          }
        }

        // 子 Agent 不显示 spinner（避免与父 Agent 输出冲突）
        if (!this.isSubAgent) startSpinner();

        // ── 流式工具并发执行 ──
        const earlyExecutions = new Map<string, Promise<string>>();

        // ── 调用 LLM（流式） ──
        const response = await this.callApi((block) => {
          const input = block.input as Record<string, any>;
          // 仅对并发安全工具（无副作用的只读工具）启用提前执行
          if (CONCURRENCY_SAFE_TOOLS.has(block.name)) {
            const perm = checkPermission(
              block.name,
              input,
              this.permissionMode,
              this.planFilePath || undefined,
            );
            // 仅 action=allow 时提前执行（需确认或被拒绝的不提前启动）
            if (perm.action === 'allow') {
              earlyExecutions.set(
                block.id,
                Promise.resolve(
                  executeTool(block.name, input, this.readFileState),
                ),
              );
            }
          }
        });

        if (!this.isSubAgent) stopSpinner();

        // 记录 token 用量
        this.totalInputTokens += response.usage.input_tokens;
        this.totalOutputTokens += response.usage.output_tokens;
        this.lastInputTokenCount = response.usage.input_tokens;
        this.lastApiCallTime = Date.now();

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

        // contextBreak 标志：当 plan 审批选择"清空上下文并执行"时，
        // 需要跳出当前工具执行循环，让模型以全新上下文继续
        let contextBreak = false;

        for (const toolUse of toolUses) {
          if (contextBreak || this.abortController.signal.aborted) break;

          const input = toolUse.input as Record<string, any>;
          printToolCall(toolUse.name, input);

          // ── 流式提前执行：如果该工具已在流式阶段启动，直接消费结果 ──
          const earlyPromise = earlyExecutions.get(toolUse.id);
          if (earlyPromise) {
            const raw = await earlyPromise;
            const result = this.persistLargeResult(toolUse.name, raw);
            printToolResult(toolUse.name, result);
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: result,
            });
            continue;
          }

          // 拦截 plan mode 工具（由 Agent 内部处理，不走常规工具路由）
          if (
            toolUse.name === 'enter_plan_mode' ||
            toolUse.name === 'exit_plan_mode'
          ) {
            const result = await this.executePlanModeTool(toolUse.name);
            printToolResult(toolUse.name, result);

            // 处理上下文清理：将结果以 user 消息注入而非 tool_result
            if (this.contextCleared) {
              this.contextCleared = false;
              this.messages.push({ role: 'user', content: result });
              contextBreak = true;
              break;
            }
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: result,
            });
            continue;
          }

          // 拦截 agent 工具（由 Agent 内部处理，避免循环依赖）
          // agent 工具派生子 Agent 实例，在独立上下文中执行任务
          if (toolUse.name === 'agent') {
            const result = await this.executeAgentTool(input);
            printToolResult(toolUse.name, result);
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: result,
            });
            continue;
          }

          // MCP 工具路由：检测 mcp__ 前缀的工具名，转发到对应的 MCP 服务器
          if (this.mcpManager.isMcpTool(toolUse.name)) {
            // Plan 模式下禁止 MCP 工具调用（plan 模式是只读的）
            if (this.permissionMode === 'plan') {
              printDenied(this.permissionMode);
              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: 'Action denied by permission mode.',
              });
              continue;
            }

            try {
              const mcpResult = await this.mcpManager.callTool(
                toolUse.name,
                input,
              );
              const result = this.persistLargeResult(toolUse.name, mcpResult);
              printToolResult(toolUse.name, result);
              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: result,
              });
            } catch (err: any) {
              const errorMsg = `MCP tool error: ${err.message}`;
              printToolResult(toolUse.name, errorMsg);
              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: errorMsg,
                is_error: true,
              });
            }
            continue;
          }

          // 权限检查（传入 planFilePath 以支持 plan 文件白名单）
          // 返回结构化结果 { action, message? }，message 携带确认描述或拒绝原因
          const perm = checkPermission(
            toolUse.name,
            input,
            this.permissionMode,
            this.planFilePath || undefined,
          );
          if (perm.action === 'deny') {
            printDenied(this.permissionMode);
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: `Action denied: ${perm.message || 'permission mode'}`,
            });
            continue;
          }
          if (perm.action === 'confirm' && perm.message) {
            // 会话白名单：已确认过的路径/命令自动放行
            if (!this.confirmedPaths.has(perm.message)) {
              const allowed = await this.confirm(`Allow: ${perm.message}`);
              if (!allowed) {
                toolResults.push({
                  type: 'tool_result',
                  tool_use_id: toolUse.id,
                  content: 'User denied this action.',
                });
                continue;
              }
              this.confirmedPaths.add(perm.message);
            }
          }

          // 执行工具，传入 readFileState 以启用 read-before-edit 校验
          const raw = executeTool(toolUse.name, input, this.readFileState);
          const result = this.persistLargeResult(toolUse.name, raw);
          printToolResult(toolUse.name, result);

          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: result,
          });
        }

        // 工具结果作为 user 消息加入（Anthropic API 规定）
        // contextBreak 时结果已单独注入，不再重复添加
        if (!contextBreak && toolResults.length > 0) {
          this.messages.push({ role: 'user', content: toolResults });
        }
        this.contextCleared = false;
      }
    } finally {
      // 清理未消费的记忆预取：通过 abort 取消后台 sideQuery 请求
      if (this.memoryPrefetch && !this.memoryPrefetch.consumed) {
        this.abortController?.abort();
      }
      this.memoryPrefetch = null;
      this.abortController = null;
      // 子 Agent 不做会话持久化（短暂任务，无需保存）
      if (!this.isSubAgent) {
        this.autoSave();
      }
    }
  }

  // ─── 会话持久化 ─────────────────────────────────────

  /**
   * 自动保存当前会话到磁盘
   *
   * 在 chat() 的 finally 块中调用，确保每次对话（无论成功、失败还是被中断）
   * 都会保存当前状态。即使用户按 Ctrl+C 中断了请求，已累积的消息也会被保存。
   *
   * 保存的数据结构：
   * - metadata: 轻量级信息（id、模型、工作目录、启动时间、消息数）
   * - messages: 完整的 Anthropic MessageParam 数组（包括 tool_use 和 tool_result）
   *
   * 外层 try/catch 确保磁盘错误（空间不足、权限问题等）不会中断用户的交互流程。
   * 这是 "fire and forget" 语义 —— 持久化是锦上添花，不是核心功能。
   *
   * 注意：messages 是引用传递，但 saveSession() 内部通过 JSON.stringify()
   * 做了深拷贝快照，所以后续对 messages 的修改不会影响已保存的数据。
   */
  private autoSave(): void {
    try {
      saveSession(this.sessionId, {
        metadata: {
          id: this.sessionId,
          model: this.model,
          cwd: process.cwd(),
          startTime: this.sessionStartTime,
          messageCount: this.messages.length,
        },
        messages: this.messages,
      });
    } catch {
      // 持久化失败不应影响主流程
    }
  }

  // ─── API 调用（流式）─────────────────────────────────

  /**
   * 调用 Anthropic Messages API（流式）
   *
   * 流式打印文本内容给用户，最终返回完整 Message 对象。
   *
   * 流式工具执行（Streaming Tool Execution）：
   * 当提供 onToolBlockComplete 回调时，每当一个 tool_use content block
   * 在流式传输中完成（content_block_stop 事件），立即触发回调。
   * 调用方可在回调中启动工具执行，使其与后续 block 的流式传输并发进行。
   * 通过 toolBlocksByIndex Map 追踪每个 tool_use block 的流式 JSON 输入，
   * 在 block 结束时解析完整 JSON 并构造 ToolUseBlock 对象传给回调。
   *
   * Extended Thinking 处理：
   * 当 thinkingMode 不为 "disabled" 时：
   * 1. max_tokens 使用模型特定的最大值（而非固定 16384）
   * 2. API 请求中附加 thinking 参数：{ type: "enabled", budget_tokens: maxOutput - 1 }
   * 3. 流式事件中监听 thinking content block，实时展示思考过程（dim 样式）
   * 4. 最终返回的 message 中过滤掉 thinking blocks，不存入对话历史
   *
   * 为什么不存 thinking blocks：
   * - thinking 是模型的中间推理过程，不是对用户的回答
   * - 存入历史会占用大量上下文空间
   * - Anthropic API 在后续轮次中也不期望收到 thinking blocks
   *
   * @param onToolBlockComplete 可选回调，每个 tool_use block 流式完成时触发。
   *                            调用方据此在响应未结束前就启动并发安全工具的执行。
   */
  private async callApi(
    onToolBlockComplete?: (block: StreamedToolUseBlock) => void,
  ): Promise<Anthropic.Message> {
    return withRetry(async (signal) => {
      // 根据 thinking 模式决定 max_tokens
      const maxOutput = getMaxOutputTokens(this.model);
      const thinkingEnabled =
        this.thinkingMode === 'adaptive' || this.thinkingMode === 'enabled';

      const stream = this.client.messages.stream(
        {
          model: this.model,
          max_tokens: thinkingEnabled ? maxOutput : 16384,
          system: this.systemPrompt,
          tools: this.customTools || [...toolDefinitions, ...this.mcpTools],
          messages: this.messages,
          // thinking 参数：budget_tokens 必须严格小于 max_tokens（API 约束）
          ...(thinkingEnabled && {
            thinking: {
              type: 'enabled' as const,
              budget_tokens: maxOutput - 1,
            },
          }),
        },
        { signal },
      );

      // 流式输出文本内容（子 Agent 输出到缓冲区，父 Agent 输出到 stdout）
      let firstText = true;
      stream.on('text', (text: string) => {
        if (firstText) {
          if (!this.isSubAgent) stopSpinner();
          this.emitText('\n');
          firstText = false;
        }
        this.emitText(text);
      });

      // ── 统一 streamEvent 处理器：thinking 输出 + tool_use block 追踪 ──
      //
      // 追踪进行中的 tool_use block：按流式事件的 index 分组，
      // 逐步累积 input_json_delta 中的 JSON 片段。
      // 当 content_block_stop 触发时，解析完整 JSON 并通知调用方。
      const toolBlocksByIndex = new Map<
        number,
        { id: string; name: string; inputJson: string }
      >();
      let inThinking = false;

      stream.on('streamEvent' as any, (event: any) => {
        // ── thinking block 处理 ──
        if (
          event.type === 'content_block_start' &&
          event.content_block?.type === 'thinking'
        ) {
          if (this.thinkingMode !== 'disabled') {
            inThinking = true;
            if (!this.isSubAgent) stopSpinner();
            printThinkingStart();
          }
        } else if (
          event.type === 'content_block_delta' &&
          event.delta?.type === 'thinking_delta' &&
          inThinking
        ) {
          printThinkingDelta(event.delta.thinking);
        }

        // ── tool_use block 追踪：记录新 block 的 id 和 name ──
        if (
          event.type === 'content_block_start' &&
          event.content_block?.type === 'tool_use'
        ) {
          toolBlocksByIndex.set(event.index, {
            id: event.content_block.id,
            name: event.content_block.name,
            inputJson: '',
          });
        }

        // ── tool_use block 追踪：累积 JSON 输入片段 ──
        if (
          event.type === 'content_block_delta' &&
          event.delta?.type === 'input_json_delta'
        ) {
          const tb = toolBlocksByIndex.get(event.index);
          if (tb) tb.inputJson += event.delta.partial_json;
        }

        // ── content_block_stop：结束 thinking 或触发 tool 回调 ──
        if (event.type === 'content_block_stop') {
          if (inThinking) {
            printThinkingEnd();
            inThinking = false;
          }

          // 如果该 index 对应 tool_use block，解析累积的 JSON 并触发回调
          const tb = toolBlocksByIndex.get(event.index);
          if (tb && onToolBlockComplete) {
            let parsedInput: Record<string, any> = {};
            try {
              parsedInput = JSON.parse(tb.inputJson || '{}');
            } catch {
              // JSON 解析失败时传空对象，不阻塞流式处理
            }
            onToolBlockComplete({
              type: 'tool_use',
              id: tb.id,
              name: tb.name,
              input: parsedInput,
            });
            toolBlocksByIndex.delete(event.index);
          }
        }
      });

      const finalMessage = await stream.finalMessage();
      if (!firstText) this.emitText('\n');

      // 过滤掉 thinking blocks，不存入对话历史
      (finalMessage as any).content = finalMessage.content.filter(
        (block: any) => block.type !== 'thinking',
      );

      return finalMessage;
    }, this.abortController?.signal);
  }

  // ─── 辅助方法 ────────────────────────────────────────

  /**
   * 大结果持久化：超过 30KB 的工具结果写入磁盘，上下文只保留预览
   */
  private persistLargeResult(toolName: string, result: string): string {
    const THRESHOLD = 30 * 1024;
    if (Buffer.byteLength(result) <= THRESHOLD) return result;

    const dir = join(homedir(), '.coding-agent', 'tool-results');
    mkdirSync(dir, { recursive: true });
    const filename = `${Date.now()}-${toolName}.txt`;
    const filepath = join(dir, filename);
    writeFileSync(filepath, result);

    const lines = result.split('\n');
    const preview = lines.slice(0, 200).join('\n');
    const sizeKB = (Buffer.byteLength(result) / 1024).toFixed(1);

    return (
      `[Result too large (${sizeKB} KB, ${lines.length} lines). Full output saved to ${filepath}. Use read_file to see the full result.]\n\n` +
      `Preview (first 200 lines):\n${preview}`
    );
  }

  private isBudgetExceeded(): boolean {
    if (this.maxTurns && this.currentTurns >= this.maxTurns) {
      printBudgetExceeded(`Turn limit reached (${this.maxTurns})`);
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
        printBudgetExceeded(`Cost limit reached ($${cost.toFixed(4)})`);
        return true;
      }
    }
    return false;
  }

  private async confirm(message: string): Promise<boolean> {
    if (this.confirmFn) return this.confirmFn(message);
    printConfirmFallback(message);
    return false;
  }

  // ─── Sub-Agent 执行 ─────────────────────────────────

  /**
   * 执行 agent 工具调用 —— 派生子 Agent 处理任务
   *
   * 流程：
   * 1. 解析 type/description/prompt 参数
   * 2. 通过 getSubAgentConfig() 获取子 Agent 的系统提示和工具集
   * 3. 创建独立的 Agent 实例（isSubAgent=true），使用父 Agent 的 API 配置
   * 4. 调用 subAgent.runOnce() 执行任务，捕获输出文本
   * 5. 累加子 Agent 的 token 用量到父 Agent
   *
   * 子 Agent 的权限模式：
   * - 父 Agent 在 plan 模式 → 子 Agent 也用 plan（保持只读约束）
   * - 其他模式 → 子 Agent 用 bypassPermissions（子 Agent 是受控环境，无需二次确认）
   *
   * 递归防护：
   * getSubAgentConfig() 返回的工具集已排除 "agent" 工具，
   * 子 Agent 无法再次调用 agent 工具派生孙 Agent。
   *
   * @param input 工具输入参数 { type?, description, prompt }
   * @returns     子 Agent 的执行结果文本
   */
  private async executeAgentTool(
    input: Record<string, any>,
  ): Promise<string> {
    const type = (input.type || 'general') as SubAgentType;
    const description = input.description || 'sub-agent task';
    const prompt = input.prompt || '';

    printSubAgentStart(type, description);

    const config = getSubAgentConfig(type);
    const subAgent = new Agent({
      apiKey: this.client.apiKey || '',
      apiBaseUrl: (this.client as any).baseURL || '',
      model: this.model,
      customSystemPrompt: config.systemPrompt,
      customTools: config.tools,
      isSubAgent: true,
      permissionMode:
        this.permissionMode === 'plan' ? 'plan' : 'bypassPermissions',
    });

    try {
      const result = await subAgent.runOnce(prompt);
      this.totalInputTokens += result.tokens.input;
      this.totalOutputTokens += result.tokens.output;
      printSubAgentEnd(type, description);
      return result.text || '(Sub-agent produced no output)';
    } catch (e: any) {
      printSubAgentEnd(type, description);
      return `Sub-agent error: ${e.message}`;
    }
  }

  // ─── Plan Mode 内部方法 ─────────────────────────────

  /**
   * 生成 plan 文件路径
   *
   * 路径格式：~/.coding-agent/plans/plan-{sessionId}.md
   * 每个会话有独立的 plan 文件，避免冲突。
   */
  private generatePlanFilePath(): string {
    const dir = join(homedir(), '.coding-agent', 'plans');
    mkdirSync(dir, { recursive: true });
    return join(dir, `plan-${this.sessionId}.md`);
  }

  /**
   * 构建 plan 模式的系统提示追加段
   *
   * 告诉模型：
   * 1. 当前处于只读规划阶段
   * 2. 唯一允许写入的文件是 plan 文件
   * 3. 应该遵循的工作流程（探索 → 设计 → 写计划 → 退出）
   * 4. 完成后必须调用 exit_plan_mode
   */
  private buildPlanModePrompt(): string {
    return `

# Plan Mode Active

Plan mode is active. You MUST NOT make any edits (except the plan file below), run non-readonly tools, or make any changes to the system.

## Plan File: ${this.planFilePath}
Write your plan incrementally to this file using write_file or edit_file. This is the ONLY file you are allowed to edit.

## Workflow
1. **Explore**: Read code to understand the task. Use read_file, list_files, grep_search.
2. **Design**: Design your implementation approach.
3. **Write Plan**: Write a structured plan to the plan file including:
   - **Context**: Why this change is needed
   - **Steps**: Implementation steps with critical file paths
   - **Verification**: How to test the changes
4. **Exit**: Call exit_plan_mode when your plan is ready for user review.

IMPORTANT: When your plan is complete, you MUST call exit_plan_mode. Do NOT ask the user to approve — exit_plan_mode handles that.`;
  }

  /**
   * 执行 plan mode 工具（enter/exit）
   *
   * 拦截 enter_plan_mode 和 exit_plan_mode 的调用，
   * 在 Agent 层面处理状态切换和审批流程。
   *
   * enter_plan_mode 流程：
   * - 保存当前权限模式 → 切换到 plan → 生成 plan 文件 → 追加系统提示
   * - 返回提示文本告知模型 plan 文件路径和工作流程
   *
   * exit_plan_mode 流程：
   * - 读取 plan 文件内容 → 调用 planApprovalFn 获取用户选择
   * - keep-planning: 保持 plan 模式，将用户反馈返回给模型
   * - clear-and-execute: 清空消息历史，设置 contextCleared 标志，
   *   权限切换到 acceptEdits
   * - execute: 保留上下文，权限切换到 acceptEdits
   * - manual-execute: 保留上下文，恢复原始权限模式
   */
  private async executePlanModeTool(name: string): Promise<string> {
    if (name === 'enter_plan_mode') {
      if (this.permissionMode === 'plan') {
        return 'Already in plan mode.';
      }
      this.prePlanMode = this.permissionMode;
      this.permissionMode = 'plan';
      this.planFilePath = this.generatePlanFilePath();
      this.systemPrompt = this.baseSystemPrompt + this.buildPlanModePrompt();
      printInfo(
        'Entered plan mode (read-only). Plan file: ' + this.planFilePath,
      );
      return (
        `Entered plan mode. You are now in read-only mode.\n\n` +
        `Your plan file: ${this.planFilePath}\n` +
        `Write your plan to this file. This is the only file you can edit.\n\n` +
        `When your plan is complete, call exit_plan_mode.`
      );
    }

    if (name === 'exit_plan_mode') {
      if (this.permissionMode !== 'plan') {
        return 'Not in plan mode.';
      }

      // 读取 plan 文件内容
      let planContent = '(No plan file found)';
      if (this.planFilePath && existsSync(this.planFilePath)) {
        planContent = readFileSync(this.planFilePath, 'utf-8');
      }

      // 交互式审批流程
      if (this.planApprovalFn) {
        const result = await this.planApprovalFn(planContent);

        // 用户选择继续规划：返回反馈给模型
        if (result.choice === 'keep-planning') {
          const feedback = result.feedback || 'Please revise the plan.';
          return (
            `User rejected the plan and wants to keep planning.\n\n` +
            `User feedback: ${feedback}\n\n` +
            `Please revise your plan based on this feedback. When done, call exit_plan_mode again.`
          );
        }

        // 用户批准：确定目标权限模式
        let targetMode: PermissionMode;
        if (
          result.choice === 'clear-and-execute' ||
          result.choice === 'execute'
        ) {
          targetMode = 'acceptEdits';
        } else {
          // manual-execute: 恢复进入 plan 前的原始权限模式
          targetMode = this.prePlanMode || 'default';
        }

        // 退出 plan 模式
        this.permissionMode = targetMode;
        this.prePlanMode = null;
        const savedPlanPath = this.planFilePath;
        this.planFilePath = null;
        this.systemPrompt = this.baseSystemPrompt;

        // 清空上下文并执行：消息历史清空，plan 内容作为新的起点
        if (result.choice === 'clear-and-execute') {
          this.clearHistoryKeepSystem();
          this.contextCleared = true;
          printInfo(
            `Plan approved. Context cleared, executing in ${targetMode} mode.`,
          );
          return (
            `User approved the plan. Context was cleared. Permission mode: ${targetMode}\n\n` +
            `Plan file: ${savedPlanPath}\n\n` +
            `## Approved Plan:\n${planContent}\n\n` +
            `Proceed with implementation.`
          );
        }

        printInfo(`Plan approved. Executing in ${targetMode} mode.`);
        return (
          `User approved the plan. Permission mode: ${targetMode}\n\n` +
          `## Approved Plan:\n${planContent}\n\n` +
          `Proceed with implementation.`
        );
      }

      // 回退：无审批回调时直接退出 plan 模式（如非交互模式）
      this.permissionMode = this.prePlanMode || 'default';
      this.prePlanMode = null;
      this.planFilePath = null;
      this.systemPrompt = this.baseSystemPrompt;
      printInfo(
        'Exited plan mode. Restored to ' + this.permissionMode + ' mode.',
      );
      return (
        `Exited plan mode. Permission mode restored to: ${this.permissionMode}\n\n` +
        `## Your Plan:\n${planContent}`
      );
    }

    return `Unknown plan mode tool: ${name}`;
  }

  /**
   * 清理消息历史但保留系统提示
   *
   * 用于 plan 审批的"清空上下文并执行"选项。
   * 清空 messages 数组和 lastInputTokenCount，
   * 让模型以全新的上下文开始执行 plan。
   *
   * 注意：Anthropic API 的 system prompt 不在 messages 数组中，
   * 所以清空 messages 不会影响系统提示。
   */
  private clearHistoryKeepSystem(): void {
    this.messages = [];
    this.lastInputTokenCount = 0;
  }

  // ─── 上下文压缩管道 ─────────────────────────────────

  /**
   * 运行零 API 开销的压缩管道（Tier 1-3）
   *
   * 在每次 API 调用前执行，按激进程度递增：
   * - Tier 1: 按预算截断大结果（上下文 > 50%）
   * - Tier 2: 用占位符替换旧/重复的工具结果（上下文 > 60%）
   * - Tier 3: 缓存冷却后激进清理（空闲 > 5 分钟）
   */
  private runCompressionPipeline(): void {
    this.budgetToolResults();
    this.snipStaleResults();
    this.microcompact();
  }

  /**
   * Tier 1: 按预算动态截断大工具结果
   *
   * 当上下文利用率超过 50% 时启用。原理：
   *
   * 1. 计算当前利用率 = lastInputTokenCount / effectiveWindow
   * 2. 根据利用率确定"字符预算"：
   *    - 50%~70%: 预算 30,000 字符（宽松）
   *    - >70%:    预算 15,000 字符（紧凑）
   * 3. 遍历所有 tool_result 块，超出预算的保留头尾各一半
   *
   * 为什么保留头尾而非只保留头部？
   * - 头部：包含文件开头、命令输出的初始信息
   * - 尾部：包含错误信息、最终结果、返回值
   * - 中间：通常是重复性内容（代码行、日志条目）
   *
   * 注意：此操作直接修改 messages 数组中的内容（原地修改），
   * 被截断的数据无法恢复，模型需要重新调用工具才能获取完整内容。
   */
  private budgetToolResults(): void {
    const utilization = this.lastInputTokenCount / this.effectiveWindow;
    if (utilization < 0.5) return;
    const budget = utilization > 0.7 ? 15000 : 30000;

    for (const msg of this.messages) {
      if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;
      for (const block of msg.content as any[]) {
        if (
          block.type === 'tool_result' &&
          typeof block.content === 'string' &&
          block.content.length > budget
        ) {
          // 保留 (budget - 80) / 2 字符的头部和尾部，80 是截断提示文本的预留
          const keepEach = Math.floor((budget - 80) / 2);
          block.content =
            block.content.slice(0, keepEach) +
            `\n\n[... budgeted: ${block.content.length - keepEach * 2} chars truncated ...]\n\n` +
            block.content.slice(-keepEach);
        }
      }
    }
  }

  /**
   * Tier 2: 用占位符替换旧/重复的工具结果
   *
   * 当上下文利用率超过 SNIP_THRESHOLD（60%）时启用。
   *
   * 算法流程：
   * 1. 收集所有 SNIPPABLE_TOOLS 的 tool_result 块（跳过已被 snip 的）
   * 2. 通过 tool_use_id 反查对应的 assistant 消息，获取工具名和输入参数
   * 3. 确定哪些结果需要被 snip：
   *    a. 去重：同一文件被 read_file 多次 → 只保留最后一次
   *    b. 老化：超出 KEEP_RECENT_RESULTS（3）的旧结果全部 snip
   * 4. 将选中的结果内容替换为 SNIP_PLACEHOLDER
   *
   * 为什么模型不会因为结果被 snip 而出错？
   * - 占位符 "[Content snipped - re-read if needed]" 明确告知模型数据已被裁剪
   * - 模型会自动重新调用 read_file 等工具获取最新内容
   * - 这是一种"惰性保留"策略：只在模型真正需要时才加载完整数据
   *
   * 数据结构说明：
   * - msgIdx/blockIdx: 定位到 messages[msgIdx].content[blockIdx] 的 tool_result 块
   * - seenFiles: 记录每个文件路径被读取的所有位置索引，用于去重
   * - toSnip: 最终需要替换的结果索引集合
   */
  private snipStaleResults(): void {
    const utilization = this.lastInputTokenCount / this.effectiveWindow;
    if (utilization < SNIP_THRESHOLD) return;

    // Step 1: 收集所有可 snip 的 tool_result 及其位置信息
    const results: {
      msgIdx: number;
      blockIdx: number;
      toolName: string;
      filePath?: string;
    }[] = [];

    for (let mi = 0; mi < this.messages.length; mi++) {
      const msg = this.messages[mi];
      if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;
      for (let bi = 0; bi < msg.content.length; bi++) {
        const block = msg.content[bi] as any;
        if (
          block.type === 'tool_result' &&
          typeof block.content === 'string' &&
          block.content !== SNIP_PLACEHOLDER
        ) {
          // 通过 tool_use_id 反查 assistant 消息中的 tool_use 块
          // 获取工具名和输入参数（如 file_path）
          const toolInfo = this.findToolUseById(block.tool_use_id);
          if (toolInfo && SNIPPABLE_TOOLS.has(toolInfo.name)) {
            results.push({
              msgIdx: mi,
              blockIdx: bi,
              toolName: toolInfo.name,
              filePath: toolInfo.input?.file_path,
            });
          }
        }
      }
    }

    // 结果数量少于保留阈值，无需 snip
    if (results.length <= KEEP_RECENT_RESULTS) return;

    const toSnip = new Set<number>();
    const seenFiles = new Map<string, number[]>();

    // Step 2: 记录同一文件的所有读取位置
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.toolName === 'read_file' && r.filePath) {
        const existing = seenFiles.get(r.filePath) || [];
        existing.push(i);
        seenFiles.set(r.filePath, existing);
      }
    }

    // Step 3a: 同一文件的早期读取全部标记为 snip（只保留最后一次）
    for (const indices of seenFiles.values()) {
      if (indices.length > 1) {
        for (let j = 0; j < indices.length - 1; j++) toSnip.add(indices[j]);
      }
    }

    // Step 3b: 超出保留数量的旧结果全部标记为 snip
    const snipBefore = results.length - KEEP_RECENT_RESULTS;
    for (let i = 0; i < snipBefore; i++) toSnip.add(i);

    // Step 4: 执行替换
    for (const idx of toSnip) {
      const r = results[idx];
      const block = (this.messages[r.msgIdx].content as any[])[r.blockIdx];
      block.content = SNIP_PLACEHOLDER;
    }
  }

  /**
   * Tier 3: Microcompact —— 缓存冷却后激进清理
   *
   * 触发条件：距上次 API 调用超过 5 分钟（MICROCOMPACT_IDLE_MS）
   *
   * 背景：
   * Anthropic 的 prompt cache 有 5 分钟的 TTL（Time To Live）。
   * 如果用户离开了一段时间再回来，cache 已经失效了，
   * 下次请求会重新处理整个上下文（无论是否压缩）。
   * 既然 cache 反正要重建，不如趁机激进清理，减小上下文体积。
   *
   * 与 Tier 2 的区别：
   * - Tier 2 只 snip SNIPPABLE_TOOLS 的结果
   * - Tier 3 清理所有 tool_result（不区分工具类型）
   * - Tier 3 用 "[Old result cleared]" 而非 SNIP_PLACEHOLDER
   *
   * 使用不同占位符的原因：
   * - SNIP_PLACEHOLDER 暗示"可以重新读取"，适合 read_file 等
   * - "[Old result cleared]" 语义更强，表示"这是旧数据，已不再相关"
   */
  private microcompact(): void {
    // 首次调用（lastApiCallTime=0）或冷却时间未到 → 跳过
    if (
      !this.lastApiCallTime ||
      Date.now() - this.lastApiCallTime < MICROCOMPACT_IDLE_MS
    )
      return;

    // 收集所有未被清理的 tool_result 块
    const allResults: { msgIdx: number; blockIdx: number }[] = [];
    for (let mi = 0; mi < this.messages.length; mi++) {
      const msg = this.messages[mi];
      if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;
      for (let bi = 0; bi < msg.content.length; bi++) {
        const block = msg.content[bi] as any;
        if (
          block.type === 'tool_result' &&
          typeof block.content === 'string' &&
          block.content !== SNIP_PLACEHOLDER &&
          block.content !== '[Old result cleared]'
        ) {
          allResults.push({ msgIdx: mi, blockIdx: bi });
        }
      }
    }

    // 保留最近 KEEP_RECENT_RESULTS 个，清理其余
    const clearCount = allResults.length - KEEP_RECENT_RESULTS;
    for (let i = 0; i < clearCount && i < allResults.length; i++) {
      const r = allResults[i];
      (this.messages[r.msgIdx].content as any[])[r.blockIdx].content =
        '[Old result cleared]';
    }
  }

  /**
   * Tier 4: 自动压缩检查
   *
   * 在每轮对话开始时（chat() 入口处）调用。
   * 当上下文利用率超过 85% 时，触发 compactConversation() 做 API 摘要。
   *
   * 为什么阈值是 85% 而不是更高？
   * - 模型的单次输出也会占用上下文空间（max_tokens=16384）
   * - 需要留出余量给下一轮的输入+输出
   * - 85% + 模型输出 ≈ 接近 100%，再高可能导致 API 报错
   *
   * 为什么在 chat() 入口而不是循环内？
   * - 循环内已有 Tier 1-3 的零开销压缩
   * - Tier 4 需要一次额外的 API 调用（有成本），不应频繁触发
   * - 放在轮次边界确保上一轮的 tool_result 不会被破坏
   */
  private async checkAndCompact(): Promise<void> {
    if (this.lastInputTokenCount > this.effectiveWindow * 0.85) {
      printInfo('Context window filling up, compacting conversation...');
      await this.compactConversation();
    }
  }

  /**
   * 对话摘要压缩（核心实现）
   *
   * 通过一次 API 调用将整个对话历史压缩为一段摘要文本。
   *
   * 流程：
   * 1. 保存最后一条 user 消息（当前轮的输入，需要保留）
   * 2. 将历史消息（去掉最后一条）+ "请总结" 指令发送给模型
   * 3. 用模型返回的摘要重建 messages 数组：
   *    [摘要(user)] → [确认(assistant)] → [当前输入(user)]
   * 4. 重置 lastInputTokenCount，让后续的利用率计算重新开始
   *
   * 压缩后的 messages 结构：
   *   messages[0]: { role: "user", content: "[Previous conversation summary]\n..." }
   *   messages[1]: { role: "assistant", content: "Understood..." }
   *   messages[2]: { role: "user", content: "（当前轮的用户输入）" }
   *
   * 这个 3 条消息的结构满足 Anthropic API 的交替规则（user→assistant→user），
   * 同时为模型提供了足够的历史上下文继续工作。
   *
   * 安全阈值：messages.length < 4 时不压缩（对话太短没有压缩价值）。
   */
  private async compactConversation(): Promise<void> {
    if (this.messages.length < 4) return;

    // 保存最后一条消息（当前轮的 user 输入）
    const lastUserMsg = this.messages[this.messages.length - 1];

    // 调用 API 生成对话摘要
    const summaryResp = await this.client.messages.create({
      model: this.model,
      max_tokens: 2048,
      system:
        'You are a conversation summarizer. Be concise but preserve important details.',
      messages: [
        // 历史消息（不含最后一条 user 输入）
        ...this.messages.slice(0, -1),
        // 替换为"请总结"指令
        {
          role: 'user',
          content:
            'Summarize the conversation so far in a concise paragraph, preserving key decisions, file paths, and context needed to continue the work.',
        },
      ],
    });

    // 提取摘要文本
    const summaryText =
      summaryResp.content[0]?.type === 'text'
        ? summaryResp.content[0].text
        : 'No summary available.';

    // 用摘要重建 messages 数组
    this.messages = [
      {
        role: 'user',
        content: `[Previous conversation summary]\n${summaryText}`,
      },
      {
        role: 'assistant',
        content:
          'Understood. I have the context from our previous conversation. How can I continue helping?',
      },
    ];
    // 把当前轮的 user 输入追加回去
    if (lastUserMsg.role === 'user') this.messages.push(lastUserMsg);
    this.lastInputTokenCount = 0;
    printInfo('Conversation compacted.');
  }

  /**
   * 在 assistant 消息中查找指定 ID 的 tool_use block
   *
   * Anthropic API 的消息结构：
   * - assistant 消息的 content 数组中包含 tool_use blocks（模型决定调用的工具）
   * - user 消息的 content 数组中包含 tool_result blocks（工具执行的结果）
   * - 两者通过 tool_use_id 关联
   *
   * 本方法用于 Tier 2 压缩中：
   * 已知一个 tool_result 的 tool_use_id，需要反查对应的工具名称和输入参数，
   * 以判断该结果是否属于 SNIPPABLE_TOOLS、是否是同一文件的重复读取。
   *
   * @param toolUseId  tool_result 块中的 tool_use_id 字段
   * @returns          对应的工具名称和输入参数，未找到返回 null
   */
  private findToolUseById(
    toolUseId: string,
  ): { name: string; input: any } | null {
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
}
