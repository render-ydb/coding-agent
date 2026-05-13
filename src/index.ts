#!/usr/bin/env node

/**
 * coding-agent CLI 入口文件
 *
 * 本文件是整个 CLI 工具的启动入口，负责：
 * 1. 解析命令行参数（权限模式等）
 * 2. 解析环境变量中的 API 密钥和端点
 * 3. 根据是否提供了 prompt 参数，决定进入一次性执行模式或交互式 REPL 模式
 * 4. 在 REPL 模式中处理用户输入、内置命令（/clear, /cost 等）和信号中断（Ctrl+C）
 */

import * as readline from "node:readline";
import "dotenv/config"; // 自动加载项目根目录下的 .env 文件到 process.env

// ─────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────

/**
 * 权限模式枚举
 *
 * 控制工具执行时的权限确认行为，从最宽松到最严格：
 * - bypassPermissions: 跳过所有确认提示，适合信任环境下的快速执行
 * - acceptEdits:       自动批准文件编辑操作，但危险的 shell 命令仍需确认
 * - default:           默认模式，危险操作和新文件写入需要用户确认
 * - plan:              只读规划模式，禁止所有写操作（仅允许写入计划文件）
 * - dontAsk:           自动拒绝所有需要确认的操作，适合 CI/CD 环境
 */
type PermissionMode =
  | "bypassPermissions"
  | "acceptEdits"
  | "default"
  | "plan"
  | "dontAsk";

/**
 * 命令行参数解析结果
 *
 * 将所有 CLI 参数整合为一个结构化对象，方便后续模块消费。
 * 设计原则：CLI 只负责解析和验证参数，不负责业务逻辑。
 */
interface ParsedArgs {
  /** 权限模式，决定工具调用时的确认行为 */
  permissionMode: PermissionMode;
  /** 用户直接提供的 prompt（一次性模式） */
  prompt?: string;
  /** 是否恢复上一次的会话 */
  resume: boolean;
  /** 是否启用扩展思考（Extended Thinking） */
  thinking: boolean;
  /** 最大花费上限（美元），超过后自动停止 */
  maxCost?: number;
  /** 最大对话轮次，超过后自动停止 */
  maxTurns?: number;
}

// ─────────────────────────────────────────────────────────
// 命令行参数解析
// ─────────────────────────────────────────────────────────

/**
 * 解析 process.argv 中的命令行参数
 *
 * 采用手动解析而非 commander/yargs 等库，原因：
 * 1. 零依赖，保持 CLI 启动速度
 * 2. 参数较少，手动解析更透明可控
 * 3. 支持位置参数（多个单词拼成 prompt）
 *
 * 参数分为三类：
 * - 布尔开关：--yolo, --plan, --thinking 等
 * - 键值对：  --max-cost <value>, --max-turns <value> 等
 * - 位置参数：所有不属于上述两类的参数，拼接为 prompt
 *
 * @returns 解析后的结构化参数对象
 */
function parseArgs(): ParsedArgs {
  // 去掉前两个元素：node 可执行文件路径 和 脚本文件路径
  const args = process.argv.slice(2);

  // 各参数的默认值
  let permissionMode: PermissionMode = "default";
  let thinking = false;
  let resume = false;
  let maxCost: number | undefined;
  let maxTurns: number | undefined;
  // 收集所有不属于任何选项的位置参数
  const positional: string[] = [];

  // 遍历参数数组，逐个识别
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    // ── 权限模式相关 ──
    // --yolo / -y：跳过所有确认（"You Only Live Once" 模式）
    if (arg === "--yolo" || arg === "-y") {
      permissionMode = "bypassPermissions";
    }
    // --plan：进入只读规划模式，模型只能读文件和写计划
    else if (arg === "--plan") {
      permissionMode = "plan";
    }
    // --accept-edits：自动批准文件编辑，但仍确认危险 shell 命令
    else if (arg === "--accept-edits") {
      permissionMode = "acceptEdits";
    }
    // --dont-ask：自动拒绝所有需要确认的操作（CI 模式）
    else if (arg === "--dont-ask") {
      permissionMode = "dontAsk";
    }

    // ── 其他选项 ──
    // --thinking：启用扩展思考（仅 Anthropic Claude 4.x 支持）
    else if (arg === "--thinking") {
      thinking = true;
    }
    // ── 会话管理 ──
    // --resume：恢复上一次的会话历史
    else if (arg === "--resume") {
      resume = true;
    }

    // ── 预算控制 ──
    // --max-cost <usd>：设定最大花费上限（美元）
    else if (arg === "--max-cost") {
      const v = parseFloat(args[++i]);
      if (!isNaN(v)) maxCost = v;
    }
    // --max-turns <n>：设定最大对话轮次
    else if (arg === "--max-turns") {
      const v = parseInt(args[++i], 10);
      if (!isNaN(v)) maxTurns = v;
    }

    // ── 帮助信息 ──
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }

    // ── 版本信息 ──
    else if (arg === "--version" || arg === "-v") {
      console.log("coding-agent v1.0.0");
      process.exit(0);
    }

    // ── 位置参数（prompt 内容） ──
    // 所有未被识别的参数都当作 prompt 的一部分
    // 这样用户可以写：coding-agent fix the bug in src/app.ts
    // 多个单词会被空格拼接为完整的 prompt
    else {
      positional.push(arg);
    }
  }

  return {
    permissionMode,
    resume,
    thinking,
    maxCost,
    maxTurns,
    // 如果有位置参数，用空格拼接为完整 prompt；否则为 undefined（进入 REPL 模式）
    prompt: positional.length > 0 ? positional.join(" ") : undefined,
  };
}

// ─────────────────────────────────────────────────────────
// 帮助信息
// ─────────────────────────────────────────────────────────

/**
 * 打印 CLI 帮助信息
 *
 * 包含所有可用选项、REPL 命令和使用示例。
 * 格式参考常见 CLI 工具的帮助输出风格。
 */
function printHelp(): void {
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

// ─────────────────────────────────────────────────────────
// API 配置
// ─────────────────────────────────────────────────────────

/**
 * API 配置结构
 *
 * 直接从 .env 文件读取，只需要两个字段：
 * - API_KEY:      API 密钥
 * - API_BASE_URL: API 端点地址
 */
interface ApiConfig {
  /** API 密钥 */
  apiKey: string;
  /** API 端点 URL */
  apiBaseUrl: string;
  /** 模型标识符（如 openai/gpt-4o） */
  model: string;
}

/**
 * 从 .env 环境变量中读取 API 配置
 *
 * 通过文件顶部的 import "dotenv/config" 已自动将 .env 加载到 process.env，
 * 这里直接读取即可，缺少任一字段则返回 null。
 *
 * @returns API 配置对象，或 null（缺少必要配置）
 */
function loadApiConfig(): ApiConfig | null {
  const apiKey = process.env.API_KEY?.trim();
  const apiBaseUrl = process.env.API_BASE_URL?.trim();
  const model = process.env.MODEL?.trim();

  if (!apiKey || !apiBaseUrl || !model) return null;

  return { apiKey, apiBaseUrl, model };
}

// ─────────────────────────────────────────────────────────
// UI 输出辅助函数
// ─────────────────────────────────────────────────────────

/**
 * 打印欢迎信息
 *
 * 在 REPL 启动时显示，包含工具名称和可用命令提示。
 * 后续可以替换为 chalk 着色版本。
 */
function printWelcome(): void {
  console.log("\n  Coding Agent — An AI-powered coding assistant\n");
  console.log("  Type your request, or 'exit' to quit.");
  console.log("  Commands: /clear /plan /cost /compact /memory /skills\n");
}

/**
 * 打印用户输入提示符
 *
 * 使用 process.stdout.write 而非 console.log，
 * 因为我们不希望在提示符后换行（用户输入会紧跟其后）。
 */
function printUserPrompt(): void {
  process.stdout.write("\n> ");
}

/**
 * 打印错误信息（带前缀）
 */
function printError(msg: string): void {
  console.error(`\n  Error: ${msg}`);
}

/**
 * 打印信息提示（非错误）
 */
function printInfo(msg: string): void {
  console.log(`\n  ℹ ${msg}`);
}

// ─────────────────────────────────────────────────────────
// REPL 交互循环
// ─────────────────────────────────────────────────────────

/**
 * 启动交互式 REPL（Read-Eval-Print Loop）
 *
 * REPL 是 CLI 的核心交互模式，负责：
 * 1. 读取用户输入
 * 2. 识别并处理内置 REPL 命令（以 / 开头）
 * 3. 将普通输入发送给 Agent 处理
 * 4. 处理 Ctrl+C 中断（第一次中断当前操作，连续两次退出程序）
 *
 * 设计要点：
 * - 使用单一 readline 实例，避免 Node.js 中多个 readline 共享 stdin 的 bug
 * - 使用 rl.once("line") 而非 rl.on("line")，确保每次输入只触发一次回调
 *   处理完成后再注册下一次监听，形成串行处理链
 * - SIGINT 信号处理分两层：Agent 运行中中断任务，空闲时要求二次确认退出
 *
 * @param config 解析后的 CLI 参数，用于将来传递给 Agent 实例
 */
async function runRepl(_config: ParsedArgs): Promise<void> {
  // 创建 readline 接口
  // 整个 REPL 生命周期只使用这一个实例
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // ── Ctrl+C (SIGINT) 处理 ──
  // sigintCount 追踪连续 Ctrl+C 的次数
  // 第一次：中断当前操作或显示提示
  // 第二次：退出程序
  let sigintCount = 0;
  // isProcessing 标记 Agent 是否正在处理请求
  // 后续接入 Agent 后，由 Agent 控制此状态
  let isProcessing = false;

  process.on("SIGINT", () => {
    if (isProcessing) {
      // Agent 正在处理中 → 中断当前操作
      // TODO: 接入 Agent 后调用 agent.abort()
      console.log("\n  (interrupted)");
      isProcessing = false;
      sigintCount = 0;
      printUserPrompt();
    } else {
      // 空闲状态 → 计数，两次退出
      sigintCount++;
      if (sigintCount >= 2) {
        console.log("\nBye!\n");
        process.exit(0);
      }
      console.log("\n  Press Ctrl+C again to exit.");
      printUserPrompt();
    }
  });

  // 显示欢迎信息
  printWelcome();

  /**
   * 递归式输入循环
   *
   * 之所以不用 for-await-of 遍历 readline，是因为：
   * 1. 需要在处理完一个输入后才监听下一个（串行化）
   * 2. 需要在异步操作（agent.chat）完成后才继续
   * 3. 这种模式给了我们精确的控制权
   */
  const askQuestion = (): void => {
    printUserPrompt();

    // 使用 once 而非 on，确保每次输入只触发一个回调
    rl.once("line", async (line) => {
      const input = line.trim();
      // 重置 Ctrl+C 计数器（用户有了新的交互）
      sigintCount = 0;

      // 空输入 → 跳过，重新提示
      if (!input) {
        askQuestion();
        return;
      }

      // 退出命令
      if (input === "exit" || input === "quit") {
        console.log("\nBye!\n");
        rl.close();
        process.exit(0);
      }

      // ── REPL 内置命令处理 ──
      // 所有以 / 开头的输入先检查是否是内置命令
      // 未匹配的 / 命令会被当作普通输入传给 Agent

      if (input === "/clear") {
        // 清空对话历史，重新开始
        // TODO: 接入 Agent 后调用 agent.clearHistory()
        printInfo("Conversation cleared.");
        askQuestion();
        return;
      }

      if (input === "/plan") {
        // 切换规划模式（只读 ↔ 正常）
        // TODO: 接入 Agent 后调用 agent.togglePlanMode()
        printInfo("Plan mode toggled. (not yet implemented)");
        askQuestion();
        return;
      }

      if (input === "/cost") {
        // 显示当前 token 用量和估算费用
        // TODO: 接入 Agent 后调用 agent.showCost()
        printInfo("Token usage: 0 in / 0 out (~$0.0000)");
        askQuestion();
        return;
      }

      if (input === "/compact") {
        // 手动触发对话压缩（摘要历史消息以腾出上下文窗口）
        // TODO: 接入 Agent 后调用 agent.compact()
        printInfo("Conversation compacted. (not yet implemented)");
        askQuestion();
        return;
      }

      if (input === "/memory") {
        // 列出所有已保存的记忆
        // TODO: 接入 memory 模块后调用 listMemories()
        printInfo("No memories saved yet.");
        askQuestion();
        return;
      }

      if (input === "/skills") {
        // 列出所有可用的技能
        // TODO: 接入 skills 模块后调用 discoverSkills()
        printInfo("No skills found. Add skills to .claude/skills/<name>/SKILL.md");
        askQuestion();
        return;
      }

      // ── 技能调用 ──
      // 以 / 开头但不是内置命令的输入，尝试作为技能调用
      // 格式: /<skill-name> [args]
      // 例如: /commit "fix type errors"
      if (input.startsWith("/")) {
        const spaceIdx = input.indexOf(" ");
        const cmdName = spaceIdx > 0 ? input.slice(1, spaceIdx) : input.slice(1);
        const _cmdArgs = spaceIdx > 0 ? input.slice(spaceIdx + 1) : "";

        // TODO: 接入 skills 模块后查找并执行技能
        // const skill = getSkillByName(cmdName);
        // if (skill && skill.userInvocable) { ... }
        printInfo(`Unknown command: /${cmdName}`);
        askQuestion();
        return;
      }

      // ── 普通用户输入 → 发送给 Agent ──
      try {
        isProcessing = true;
        // TODO: 接入 Agent 后替换为 await agent.chat(input)
        // 目前仅回显输入作为占位
        console.log(`\n  [Agent] Received: "${input}"`);
        console.log("  [Agent] (Agent not yet implemented)");
      } catch (e: unknown) {
        // 捕获 Agent 处理中的异常
        // AbortError 是用户主动中断，无需报错
        const error = e as Error;
        if (error.name === "AbortError" || error.message?.includes("aborted")) {
          // 用户主动中断，已由 SIGINT handler 处理
        } else {
          printError(error.message);
        }
      } finally {
        isProcessing = false;
      }

      // 继续等待下一轮输入
      askQuestion();
    });
  };

  // 启动第一轮输入循环
  askQuestion();
}

// ─────────────────────────────────────────────────────────
// 主函数
// ─────────────────────────────────────────────────────────

/**
 * CLI 主入口函数
 *
 * 执行流程：
 * 1. 解析命令行参数
 * 2. 解析 API 配置（密钥、端点）
 * 3. 创建 Agent 实例
 * 4. 根据参数选择运行模式：
 *    - 有 prompt → 一次性模式：执行后退出
 *    - 无 prompt → REPL 模式：启动交互循环
 *    - --resume  → 先恢复上次会话，再进入 REPL
 */
async function main(): Promise<void> {
  // Step 1: 解析命令行参数
  const config = parseArgs();

  // Step 2: 从 .env 读取 API 配置
  const apiConfig = loadApiConfig();

  if (!apiConfig) {
    printError(
      `API configuration is required.\n` +
        `  Create a .env file with:\n` +
        `    API_KEY=your-api-key\n` +
        `    API_BASE_URL=https://your-api-endpoint/v1\n` +
        `    MODEL=your-model-name`
    );
    process.exit(1);
  }

  // Step 3: 创建 Agent 实例
  // TODO: 实现 Agent 类后在此处实例化
  // const agent = new Agent({
  //   permissionMode: config.permissionMode,
  //   thinking: config.thinking,
  //   maxCostUsd: config.maxCost,
  //   maxTurns: config.maxTurns,
  //   apiKey: apiConfig.apiKey,
  //   apiBaseUrl: apiConfig.apiBaseUrl,
  // });

  printInfo(
    `Config: model=${apiConfig.model}, mode=${config.permissionMode}, api=${apiConfig.apiBaseUrl}` +
      (config.thinking ? ", thinking=on" : "") +
      (config.maxCost ? `, budget=$${config.maxCost}` : "") +
      (config.maxTurns ? `, maxTurns=${config.maxTurns}` : "")
  );

  // Step 4: 恢复会话（如果 --resume）
  if (config.resume) {
    // TODO: 接入 session 模块后恢复会话
    // const sessionId = getLatestSessionId();
    // if (sessionId) {
    //   const session = loadSession(sessionId);
    //   if (session) agent.restoreSession(session);
    // }
    printInfo("Session restore not yet implemented.");
  }

  // Step 5: 选择运行模式
  if (config.prompt) {
    // ── 一次性模式 ──
    // 用户通过 CLI 参数直接提供了 prompt，执行后退出
    // 典型用法: coding-agent "fix the bug in src/app.ts"
    try {
      // TODO: 接入 Agent 后替换为 await agent.chat(config.prompt)
      console.log(`\n  [One-shot] Prompt: "${config.prompt}"`);
      console.log("  [One-shot] (Agent not yet implemented)");
    } catch (e: unknown) {
      const error = e as Error;
      printError(error.message);
      process.exit(1);
    }
  } else {
    // ── REPL 交互模式 ──
    // 没有提供 prompt，启动交互式循环
    await runRepl(config);
  }
}

// 启动主函数
// 使用顶层 await 的替代写法：将 main() 作为 Promise 启动
// 未捕获的异常会触发 Node.js 的 unhandledRejection 处理
main();
