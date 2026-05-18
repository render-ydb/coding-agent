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

import * as readline from 'node:readline';
import 'dotenv/config';
import { Agent, type PermissionMode } from './agent.js';
import { getLatestSessionId, loadSession } from './session.js';
import { listMemories } from './memory.js';
import { discoverSkills, getSkillByName } from './skills.js';
import {
  printHelp,
  printWelcome,
  printUserPrompt,
  printError,
  printInfo,
  printPlanForApproval,
  printPlanApprovalOptions,
} from './ui.js';

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
  let permissionMode: PermissionMode = 'default';
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
    if (arg === '--yolo' || arg === '-y') {
      permissionMode = 'bypassPermissions';
    }
    // --plan：进入只读规划模式，模型只能读文件和写计划
    else if (arg === '--plan') {
      permissionMode = 'plan';
    }
    // --accept-edits：自动批准文件编辑，但仍确认危险 shell 命令
    else if (arg === '--accept-edits') {
      permissionMode = 'acceptEdits';
    }
    // --dont-ask：自动拒绝所有需要确认的操作（CI 模式）
    else if (arg === '--dont-ask') {
      permissionMode = 'dontAsk';
    }

    // ── 其他选项 ──
    // --thinking：启用扩展思考（仅 Anthropic Claude 4.x 支持）
    else if (arg === '--thinking') {
      thinking = true;
    }
    // ── 会话管理 ──
    // --resume：恢复上一次的会话历史
    else if (arg === '--resume') {
      resume = true;
    }

    // ── 预算控制 ──
    // --max-cost <usd>：设定最大花费上限（美元）
    else if (arg === '--max-cost') {
      const v = parseFloat(args[++i]);
      if (!isNaN(v)) maxCost = v;
    }
    // --max-turns <n>：设定最大对话轮次
    else if (arg === '--max-turns') {
      const v = parseInt(args[++i], 10);
      if (!isNaN(v)) maxTurns = v;
    }

    // ── 帮助信息 ──
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }

    // ── 版本信息 ──
    else if (arg === '--version' || arg === '-v') {
      console.log('coding-agent v1.0.0');
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
    prompt: positional.length > 0 ? positional.join(' ') : undefined,
  };
}

// ─────────────────────────────────────────────────────────
// API 配置
// ─────────────────────────────────────────────────────────

/**
 * API 配置结构
 *
 * 直接从 .env 文件读取：
 * - API_KEY:      API 密钥
 * - API_BASE_URL: API 端点地址
 * - MODEL:        模型标识符
 * - BACKEND:      （可选）强制指定后端类型 'anthropic' | 'openai'
 */
interface ApiConfig {
  /** API 密钥 */
  apiKey: string;
  /** API 端点 URL */
  apiBaseUrl: string;
  /** 模型标识符（如 claude-sonnet-4-6 或 gpt-4o） */
  model: string;
  /**
   * 后端类型
   *
   * 决定使用 Anthropic Messages API 还是 OpenAI Chat Completions API。
   * 可通过环境变量 BACKEND 显式指定，未指定时根据 URL 和模型名自动推断。
   */
  backend: 'anthropic' | 'openai';
}

/**
 * 从 .env 环境变量中读取 API 配置
 *
 * 通过文件顶部的 import "dotenv/config" 已自动将 .env 加载到 process.env，
 * 这里直接读取即可，缺少任一字段则返回 null。
 *
 * 后端检测优先级：
 * 1. 环境变量 BACKEND 显式指定
 * 2. URL / 模型名启发式推断
 * 3. 默认 anthropic（向后兼容）
 *
 * @returns API 配置对象，或 null（缺少必要配置）
 */
function loadApiConfig(): ApiConfig | null {
  const apiKey = process.env.API_KEY?.trim();
  const apiBaseUrl = process.env.API_BASE_URL?.trim();
  const model = process.env.MODEL?.trim();

  if (!apiKey || !apiBaseUrl || !model) return null;

  // 检测后端类型
  const backendEnv = process.env.BACKEND?.trim()?.toLowerCase();
  let backend: 'anthropic' | 'openai';

  if (backendEnv === 'openai') {
    backend = 'openai';
  } else if (backendEnv === 'anthropic') {
    backend = 'anthropic';
  } else {
    // 启发式推断：从 URL 和模型名判断
    const urlLower = apiBaseUrl.toLowerCase();
    const modelLower = model.toLowerCase();
    if (
      urlLower.includes('anthropic') ||
      modelLower.startsWith('claude') ||
      modelLower.includes('/claude')
    ) {
      backend = 'anthropic';
    } else if (
      urlLower.includes('openai.com') ||
      urlLower.includes('ollama') ||
      urlLower.includes('vllm') ||
      modelLower.startsWith('gpt-') ||
      modelLower.startsWith('o1') ||
      modelLower.startsWith('o3')
    ) {
      backend = 'openai';
    } else {
      backend = 'anthropic';
    }
  }

  return { apiKey, apiBaseUrl, model, backend };
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
async function runRepl(agent: Agent): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // 提供 confirmFn，复用 readline 实例
  agent.setConfirmFn((message: string) => {
    return new Promise((resolve) => {
      rl.question(`  ${message} (y/n): `, (answer) => {
        resolve(answer.toLowerCase().startsWith('y'));
      });
    });
  });

  // 提供 planApprovalFn，展示 plan 内容并收集用户审批决定
  agent.setPlanApprovalFn((planContent: string) => {
    return new Promise((resolve) => {
      printPlanForApproval(planContent);
      printPlanApprovalOptions();

      const askChoice = (): void => {
        rl.question('  Enter choice (1-4): ', (answer) => {
          const choice = answer.trim();
          if (choice === '1') {
            resolve({ choice: 'clear-and-execute' });
          } else if (choice === '2') {
            resolve({ choice: 'execute' });
          } else if (choice === '3') {
            resolve({ choice: 'manual-execute' });
          } else if (choice === '4') {
            rl.question('  Feedback (what to change): ', (feedback) => {
              resolve({
                choice: 'keep-planning',
                feedback: feedback.trim() || undefined,
              });
            });
          } else {
            console.log('  Invalid choice. Enter 1, 2, 3, or 4.');
            askChoice();
          }
        });
      };
      askChoice();
    });
  });

  let sigintCount = 0;
  let isProcessing = false;

  process.on('SIGINT', () => {
    if (isProcessing) {
      agent.abort();
      console.log('\n  (interrupted)');
      isProcessing = false;
      sigintCount = 0;
      printUserPrompt();
    } else {
      // 空闲状态 → 计数，两次退出
      sigintCount++;
      if (sigintCount >= 2) {
        console.log('\nBye!\n');
        process.exit(0);
      }
      console.log('\n  Press Ctrl+C again to exit.');
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
    rl.once('line', async (line) => {
      const input = line.trim();
      // 重置 Ctrl+C 计数器（用户有了新的交互）
      sigintCount = 0;

      // 空输入 → 跳过，重新提示
      if (!input) {
        askQuestion();
        return;
      }

      // 退出命令
      if (input === 'exit' || input === 'quit') {
        console.log('\nBye!\n');
        rl.close();
        process.exit(0);
      }

      // ── REPL 内置命令处理 ──
      // 所有以 / 开头的输入先检查是否是内置命令
      // 未匹配的 / 命令会被当作普通输入传给 Agent

      if (input === '/clear') {
        agent.clearHistory();
        printInfo('Conversation cleared.');
        askQuestion();
        return;
      }

      if (input === '/plan') {
        agent.togglePlanMode();
        askQuestion();
        return;
      }

      if (input === '/cost') {
        agent.showCost();
        askQuestion();
        return;
      }

      if (input === '/compact') {
        try {
          await agent.compact();
          printInfo('Conversation compacted.');
        } catch (e: unknown) {
          printError((e as Error).message);
        }
        askQuestion();
        return;
      }

      if (input === '/memory') {
        const memories = listMemories();
        if (memories.length === 0) {
          printInfo('No memories saved yet.');
        } else {
          console.log(`\n  Memories (${memories.length}):`);
          for (const m of memories) {
            console.log(
              `    [${m.type}] ${m.name} — ${m.description || '(no description)'}`,
            );
          }
          console.log();
        }
        askQuestion();
        return;
      }

      if (input === '/skills') {
        const skills = discoverSkills();
        if (skills.size === 0) {
          printInfo(
            'No skills found. Add skills to .claude/skills/<name>/SKILL.md',
          );
        } else {
          console.log(`\n  Skills (${skills.size}):`);
          for (const [name, skill] of skills) {
            const invocable = skill.userInvocable ? '/' : ' ';
            const mode = skill.context === 'fork' ? '[fork]' : '[inline]';
            const src = skill.source === 'project' ? 'project' : 'user';
            console.log(
              `    ${invocable}${name} ${mode} (${src}) — ${skill.description || '(no description)'}`,
            );
          }
          console.log();
        }
        askQuestion();
        return;
      }

      // ── 技能调用 ──
      // 以 / 开头但不是内置命令的输入，尝试作为技能调用
      // 格式: /<skill-name> [args]
      // 例如: /commit "fix type errors"
      if (input.startsWith('/')) {
        const spaceIdx = input.indexOf(' ');
        const cmdName =
          spaceIdx > 0 ? input.slice(1, spaceIdx) : input.slice(1);
        const cmdArgs = spaceIdx > 0 ? input.slice(spaceIdx + 1) : '';

        const skill = getSkillByName(cmdName);
        if (skill && skill.userInvocable) {
          // skill 调用：
          // - fork 模式：告诉 agent 使用 skill 工具（会创建子 Agent）
          // - inline 模式：直接将解析后的 prompt 作为用户消息发送给 agent
          try {
            isProcessing = true;
            if (skill.context === 'fork') {
              await agent.chat(
                `Use the skill tool to invoke "${cmdName}" with args: ${cmdArgs || '(none)'}`,
              );
            } else {
              // inline：导入并解析 skill prompt，直接作为聊天输入
              const { executeSkill: execSkill } = await import('./skills.js');
              const result = execSkill(cmdName, cmdArgs);
              if (result) {
                await agent.chat(result.prompt);
              }
            }
          } catch (e: unknown) {
            const error = e as Error;
            if (
              error.name !== 'AbortError' &&
              !error.message?.includes('aborted')
            ) {
              printError(error.message);
            }
          } finally {
            isProcessing = false;
          }
          askQuestion();
          return;
        }

        printInfo(`Unknown command: /${cmdName}`);
        askQuestion();
        return;
      }

      // ── 普通用户输入 → 发送给 Agent ──
      try {
        isProcessing = true;
        await agent.chat(input);
      } catch (e: unknown) {
        // 捕获 Agent 处理中的异常
        // AbortError 是用户主动中断，无需报错
        const error = e as Error;
        if (error.name === 'AbortError' || error.message?.includes('aborted')) {
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
        `    MODEL=your-model-name`,
    );
    process.exit(1);
  }

  const agent = new Agent({
    permissionMode: config.permissionMode,
    thinking: config.thinking,
    maxCostUsd: config.maxCost,
    maxTurns: config.maxTurns,
    apiKey: apiConfig.apiKey,
    apiBaseUrl: apiConfig.apiBaseUrl,
    model: apiConfig.model,
    backend: apiConfig.backend,
  });

  printInfo(
    `Config: model=${apiConfig.model}, mode=${config.permissionMode}, backend=${apiConfig.backend}, api=${apiConfig.apiBaseUrl}` +
      (config.thinking ? ', thinking=on' : '') +
      (config.maxCost ? `, budget=$${config.maxCost}` : '') +
      (config.maxTurns ? `, maxTurns=${config.maxTurns}` : '') +
      ` | session=${agent.getSessionId()}`,
  );

  if (config.resume) {
    const sessionId = getLatestSessionId();
    if (sessionId) {
      const sessionData = loadSession(sessionId);
      if (sessionData) {
        agent.restoreSession(sessionData);
      } else {
        printInfo(`Session ${sessionId} found but could not be loaded.`);
      }
    } else {
      printInfo('No previous session found.');
    }
  }

  if (config.prompt) {
    try {
      await agent.chat(config.prompt);
    } catch (e: unknown) {
      const error = e as Error;
      printError(error.message);
      process.exit(1);
    }
  } else {
    await runRepl(agent);
  }
}

// 启动主函数
// 使用顶层 await 的替代写法：将 main() 作为 Promise 启动
// 未捕获的异常会触发 Node.js 的 unhandledRejection 处理
main();
