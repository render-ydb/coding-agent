/**
 * UI 模块 — 终端输出的统一表现层
 *
 * 本模块将所有终端输出（console.log、process.stdout.write、console.error）
 * 集中管理，实现表现层与业务逻辑的分离。
 *
 * 设计原则：
 * - 所有面向用户的输出都通过本模块的函数完成
 * - agent.ts 和 index.ts 不应直接调用 console.log 等
 * - 暂不引入 chalk 等外部依赖，保持零新依赖
 * - 后续可统一加入颜色、主题等增强功能
 *
 * 分层结构：
 * ┌──────────────────────────────────────┐
 * │  REPL / CLI 级别                      │
 * │  printWelcome, printHelp, printPrompt│
 * ├──────────────────────────────────────┤
 * │  Agent 级别                           │
 * │  printToolCall, printToolResult,     │
 * │  printAssistantText, printCost, ...  │
 * ├──────────────────────────────────────┤
 * │  Spinner                              │
 * │  startSpinner, stopSpinner           │
 * └──────────────────────────────────────┘
 */

// ─────────────────────────────────────────────────────────
// Spinner 状态（模块级）
// ─────────────────────────────────────────────────────────

/**
 * Braille 字符序列，形成旋转动画效果
 *
 * 选择 braille 字符而非 ASCII 字符（如 |/-\）的原因：
 * - 视觉上更平滑、更现代
 * - 在等宽字体中占据稳定的 1 字符宽度
 * - 广泛支持于现代终端（macOS Terminal、iTerm2、VS Code 终端等）
 */
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** 当前 spinner 定时器，null 表示未运行 */
let spinnerTimer: ReturnType<typeof setInterval> | null = null;

/** 当前显示的帧索引 */
let spinnerFrame = 0;

// ─────────────────────────────────────────────────────────
// 工具图标和摘要（内部辅助）
// ─────────────────────────────────────────────────────────

/**
 * 根据工具名称返回对应的图标
 *
 * 图标帮助用户快速识别工具类型，无需阅读工具名称。
 * 使用 emoji 而非 ASCII 符号，因为现代终端都支持 emoji 显示。
 */
function getToolIcon(name: string): string {
  switch (name) {
    case 'read_file':
      return '📖';
    case 'write_file':
      return '✏️';
    case 'edit_file':
      return '🔧';
    case 'list_files':
      return '📁';
    case 'grep_search':
      return '🔍';
    case 'run_shell':
      return '💻';
    default:
      return '🔨';
  }
}

/**
 * 根据工具名称和输入参数生成简短的人类可读摘要
 *
 * 摘要用于在工具调用时快速展示关键信息，
 * 让用户无需查看完整参数就能理解工具在做什么。
 */
function getToolSummary(name: string, input: Record<string, any>): string {
  switch (name) {
    case 'run_shell':
      return input.command || '';
    case 'read_file':
    case 'write_file':
    case 'edit_file':
      return input.file_path || '';
    case 'grep_search':
      return `"${input.pattern}"${input.path ? ` in ${input.path}` : ''}`;
    case 'list_files':
      return input.pattern || input.path || '';
    default:
      return JSON.stringify(input).slice(0, 80);
  }
}

// ─────────────────────────────────────────────────────────
// REPL / CLI 级别输出
// ─────────────────────────────────────────────────────────

/**
 * 打印 CLI 帮助信息
 *
 * 包含所有可用选项、REPL 命令和使用示例。
 * 格式参考常见 CLI 工具的帮助输出风格。
 */
export function printHelp(): void {
  console.log(`
Usage: coding-agent [options] [prompt]

Options:
  --yolo, -y          Skip all confirmation prompts (bypass permissions)
  --plan              Plan mode: read-only, describe changes without executing
  --accept-edits      Auto-approve file edits, still confirm dangerous shell
  --dont-ask          Auto-deny anything needing confirmation (for CI)
  --thinking          Enable extended thinking (Anthropic Claude only)
  --resume            Resume the last session
  --max-cost <usd>    Stop when estimated cost exceeds this amount
  --max-turns <n>     Stop after N agentic turns
  --help, -h          Show this help
  --version, -v       Show version number

REPL commands:
  /clear              Clear conversation history
  /plan               Toggle plan mode (read-only <-> normal)
  /cost               Show token usage and cost
  /compact            Manually compact conversation
  /memory             List saved memories
  /skills             List available skills
  /<skill-name>       Invoke a skill (e.g. /commit "fix types")

Examples:
  coding-agent "fix the bug in src/app.ts"
  coding-agent --yolo "run all tests and fix failures"
  coding-agent --plan "how would you refactor this?"
  coding-agent --accept-edits "add error handling to api.ts"
  coding-agent --max-cost 0.50 --max-turns 20 "implement feature X"
  coding-agent --resume
  coding-agent  # starts interactive REPL
`);
}

/**
 * 打印欢迎信息
 *
 * 在 REPL 启动时显示，包含工具名称和可用命令提示。
 */
export function printWelcome(): void {
  console.log('\n  Coding Agent — An AI-powered coding assistant\n');
  console.log("  Type your request, or 'exit' to quit.");
  console.log('  Commands: /clear /plan /cost /compact /memory /skills\n');
}

/**
 * 打印用户输入提示符
 *
 * 使用 process.stdout.write 而非 console.log，
 * 因为不希望在提示符后换行（用户输入紧跟其后）。
 */
export function printUserPrompt(): void {
  process.stdout.write('\n> ');
}

/**
 * 打印错误信息到 stderr
 *
 * 使用 console.error 而非 console.log，
 * 这样错误信息可以被 shell 的 2> 重定向单独捕获。
 */
export function printError(msg: string): void {
  console.error(`\n  Error: ${msg}`);
}

/**
 * 打印信息提示（非错误）
 *
 * 用于通知性消息，如会话恢复、上下文压缩等操作状态。
 * 使用 ℹ 图标与错误/警告区分。
 */
export function printInfo(msg: string): void {
  console.log(`\n  ℹ ${msg}`);
}

// ─────────────────────────────────────────────────────────
// Agent 级别输出
// ─────────────────────────────────────────────────────────

/**
 * 打印工具调用信息
 *
 * 在工具执行前调用，展示工具名称和关键参数摘要。
 * 格式：▶ 图标 工具名: 摘要
 *
 * @param name  工具名称（如 read_file、run_shell）
 * @param input 工具输入参数
 */
export function printToolCall(
  name: string,
  input: Record<string, any>,
): void {
  const icon = getToolIcon(name);
  const summary = getToolSummary(name, input);
  console.log(`\n  ${icon} ${name}: ${summary}`);
}

/**
 * 打印工具执行结果
 *
 * 展示结果的前 5 行预览，超过部分显示行数统计。
 * 缩进对齐，与工具调用信息形成视觉配对。
 *
 * @param name   工具名称
 * @param result 工具执行的完整结果文本
 */
export function printToolResult(name: string, result: string): void {
  const lines = result.split('\n');
  const preview = lines.slice(0, 5).join('\n');
  const more = lines.length > 5 ? `\n    ... (${lines.length} lines)` : '';
  console.log(`  ◀ ${name}:\n    ${preview.replace(/\n/g, '\n    ')}${more}`);
}

/**
 * 流式输出 LLM 的文本内容
 *
 * 直接写入 stdout，不追加换行符。
 * 用于逐 token 展示模型的流式响应。
 */
export function printAssistantText(text: string): void {
  process.stdout.write(text);
}

/**
 * 打印 API 重试信息
 *
 * 在指数退避重试时显示当前重试次数和等待原因，
 * 让用户知道请求仍在进行中而非卡住。
 *
 * @param attempt 当前重试次数（从 1 开始）
 * @param max     最大重试次数
 * @param reason  重试原因（如 "HTTP 429"、"ECONNRESET"）
 */
export function printRetry(
  attempt: number,
  max: number,
  reason: string,
): void {
  console.log(`\n  ⟳ Retry ${attempt}/${max} (${reason})`);
}

/**
 * 打印 Token 用量和费用估算
 *
 * 费率基于 Claude Sonnet 的参考价格：
 * - 输入: $3 / 1M tokens
 * - 输出: $15 / 1M tokens
 *
 * @param inputTokens  累计输入 token 数
 * @param outputTokens 累计输出 token 数
 * @param opts         可选的预算信息（最大费用、最大轮次、当前轮次）
 */
export function printCost(
  inputTokens: number,
  outputTokens: number,
  opts?: {
    maxCostUsd?: number;
    maxTurns?: number;
    currentTurns?: number;
  },
): void {
  const costIn = (inputTokens / 1_000_000) * 3;
  const costOut = (outputTokens / 1_000_000) * 15;
  const total = costIn + costOut;
  console.log(
    `\n  Tokens: ${inputTokens} in / ${outputTokens} out` +
      `\n  Cost: ~$${total.toFixed(4)}` +
      (opts?.maxCostUsd ? ` / $${opts.maxCostUsd} budget` : '') +
      (opts?.maxTurns
        ? ` | Turns: ${opts.currentTurns ?? 0}/${opts.maxTurns}`
        : ''),
  );
}

/**
 * 打印权限拒绝信息
 *
 * 当工具调用被权限模式拒绝时显示。
 *
 * @param mode 当前权限模式名称
 */
export function printDenied(mode: string): void {
  console.log(`  ✗ Denied in ${mode} mode`);
}

/**
 * 打印预算超限警告
 *
 * 当费用或轮次达到预设上限时显示。
 *
 * @param reason 超限原因描述
 */
export function printBudgetExceeded(reason: string): void {
  console.log(`\n  ⚠ ${reason}`);
}

/**
 * 打印无确认处理器的回退提示
 *
 * 当 Agent 没有注入 confirmFn 时，工具请求确认会走到这里，
 * 自动拒绝并提示原因。
 *
 * @param message 原始确认请求消息
 */
export function printConfirmFallback(message: string): void {
  console.log(`  ⚠ ${message} — auto-denied (no confirm handler)`);
}

// ─────────────────────────────────────────────────────────
// Spinner（加载动画）
// ─────────────────────────────────────────────────────────

/**
 * 启动终端加载动画
 *
 * 在 API 调用期间显示旋转的 braille 字符，让用户知道程序正在等待响应。
 *
 * 实现原理：
 * - 使用 setInterval 每 80ms 更新一帧
 * - 通过 \r（回车）将光标移回行首，覆盖上一帧
 * - 防重入：如果 spinner 已在运行，直接返回
 *
 * @param label 加载提示文字，默认 "Thinking"
 */
export function startSpinner(label = 'Thinking'): void {
  if (spinnerTimer) return;
  spinnerFrame = 0;
  process.stdout.write(`  ${SPINNER_FRAMES[0]} ${label}`);
  spinnerTimer = setInterval(() => {
    spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
    process.stdout.write(`\r  ${SPINNER_FRAMES[spinnerFrame]} ${label}`);
  }, 80);
}

/**
 * 停止终端加载动画
 *
 * 清除定时器并擦除 spinner 行。
 * 使用 ANSI 转义序列 \x1b[K 清除从光标到行尾的内容，
 * 避免残留字符。
 */
export function stopSpinner(): void {
  if (!spinnerTimer) return;
  clearInterval(spinnerTimer);
  spinnerTimer = null;
  process.stdout.write('\r\x1b[K');
}
