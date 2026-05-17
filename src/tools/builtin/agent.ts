/**
 * agent 工具 —— 派生子 Agent 处理独立任务
 *
 * 此文件仅定义工具的 schema（名称、描述、参数格式）。
 * 实际的执行逻辑在 agent.ts 的 executeAgentTool() 中实现，
 * 因为子 Agent 需要访问 Agent 类的内部状态（client、model 等），
 * 在此处实现会产生循环依赖。
 *
 * execute 函数返回提示文本，但在正常流程中不会被调用 ——
 * agent.ts 的工具路由会在到达 executeTool() 之前拦截 "agent" 工具。
 */

import type { ToolDefinition } from '../types.js';

export const agentTool: ToolDefinition = {
  definition: {
    name: 'agent',
    description:
      'Launch a sub-agent to handle a task autonomously. Sub-agents have isolated context and return their result. ' +
      "Types: 'explore' (read-only, fast search), 'plan' (read-only, structured planning), 'general' (full tools).",
    input_schema: {
      type: 'object' as const,
      properties: {
        description: {
          type: 'string',
          description:
            "Short (3-5 word) description of the sub-agent's task",
        },
        prompt: {
          type: 'string',
          description: 'Detailed task instructions for the sub-agent',
        },
        type: {
          type: 'string',
          enum: ['explore', 'plan', 'general'],
          description:
            'Agent type: explore (read-only), plan (planning), general (full tools). Default: general',
        },
      },
      required: ['description', 'prompt'],
    },
  },
  // 占位执行函数 —— 正常流程中 agent.ts 会在路由层拦截此工具，
  // 此函数仅在工具系统直接调用时作为降级提示。
  execute: () =>
    'Error: agent tool must be handled by the Agent class, not the tool executor.',
};
