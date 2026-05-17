/**
 * Sub-Agent 配置模块
 *
 * 定义子 Agent 的类型、系统提示和工具集。
 * 父 Agent 通过 getSubAgentConfig(type) 获取配置后，
 * 创建独立的子 Agent 实例执行任务。
 *
 * 三种内置类型：
 * - explore: 只读搜索，快速定位代码（read_file, list_files, grep_search）
 * - plan:    只读分析，输出结构化方案（同 explore 工具集）
 * - general: 通用执行，拥有所有工具（排除 agent 本身防止递归）
 *
 * 设计决策：
 * - 工具过滤通过名称白名单实现，而非引用工具对象，
 *   避免与 tools/ 模块产生循环依赖
 * - 系统提示保持简洁，聚焦子 Agent 的特定职责，
 *   不包含 memory 系统指令（子 Agent 不做独立记忆召回）
 */

import type Anthropic from '@anthropic-ai/sdk';
import { toolDefinitions } from './tools/index.js';

// ─────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────

/**
 * 子 Agent 类型
 *
 * - explore: 只读搜索，用于快速定位代码片段、文件、符号
 * - plan:    只读分析，用于设计实现方案和架构决策
 * - general: 通用执行，拥有完整工具能力（排除 agent 工具）
 */
export type SubAgentType = 'explore' | 'plan' | 'general';

/**
 * 子 Agent 配置
 *
 * @property systemPrompt 子 Agent 的系统提示词，定义其角色和行为规范
 * @property tools        子 Agent 可使用的工具定义数组
 */
export interface SubAgentConfig {
  systemPrompt: string;
  tools: Anthropic.Tool[];
}

// ─────────────────────────────────────────────────────────
// 只读工具集
// ─────────────────────────────────────────────────────────

/**
 * explore 和 plan 类型共享的只读工具名称列表
 *
 * 只包含不产生副作用的读取工具，确保子 Agent
 * 在探索阶段不会意外修改文件系统。
 */
const READ_ONLY_TOOL_NAMES = new Set([
  'read_file',
  'list_files',
  'grep_search',
]);

/**
 * 从全局工具定义中按名称过滤出子集
 *
 * @param allowedNames 允许的工具名称集合
 */
function filterTools(allowedNames: Set<string>): Anthropic.Tool[] {
  return toolDefinitions.filter((t) => allowedNames.has(t.name));
}

/**
 * 获取 general 类型的工具集：所有工具排除 agent（防止递归派生）
 */
function getGeneralTools(): Anthropic.Tool[] {
  return toolDefinitions.filter((t) => t.name !== 'agent');
}

// ─────────────────────────────────────────────────────────
// 系统提示
// ─────────────────────────────────────────────────────────

const EXPLORE_PROMPT = `You are a code exploration sub-agent.
Your job is to quickly search and locate relevant code, files, and patterns in the codebase.

# Rules
- Use read_file, list_files, and grep_search to find information.
- Be thorough but fast — search multiple angles if the first attempt doesn't find what you need.
- Report your findings concisely: file paths, line numbers, and relevant code snippets.
- Do NOT suggest changes — only report what you find.

# Environment
- Working directory: ${process.cwd()}`;

const PLAN_PROMPT = `You are a planning sub-agent.
Your job is to analyze code and produce a structured implementation plan.

# Rules
- Use read_file, list_files, and grep_search to understand the codebase.
- Produce a clear, actionable plan with:
  - Context: what problem this solves
  - Steps: specific implementation steps with file paths
  - Risks: potential issues or edge cases
- Do NOT make any changes — only analyze and plan.

# Environment
- Working directory: ${process.cwd()}`;

const GENERAL_PROMPT = `You are a general-purpose sub-agent.
Your job is to complete a specific task autonomously and report the result.

# Rules
- Read files before editing them.
- Use dedicated tools instead of shell commands for file operations.
- Be concise in your output — focus on what you did and the result.
- Complete the task fully before responding.

# Environment
- Working directory: ${process.cwd()}`;

// ─────────────────────────────────────────────────────────
// 配置获取
// ─────────────────────────────────────────────────────────

/**
 * 根据子 Agent 类型获取对应的配置（系统提示 + 工具集）
 *
 * 默认类型为 "general"，提供完整工具能力。
 * 未识别的类型也回退到 "general"。
 *
 * @param type 子 Agent 类型，默认 "general"
 * @returns    包含 systemPrompt 和 tools 的配置对象
 */
export function getSubAgentConfig(type: SubAgentType = 'general'): SubAgentConfig {
  switch (type) {
    case 'explore':
      return {
        systemPrompt: EXPLORE_PROMPT,
        tools: filterTools(READ_ONLY_TOOL_NAMES),
      };
    case 'plan':
      return {
        systemPrompt: PLAN_PROMPT,
        tools: filterTools(READ_ONLY_TOOL_NAMES),
      };
    case 'general':
    default:
      return {
        systemPrompt: GENERAL_PROMPT,
        tools: getGeneralTools(),
      };
  }
}
