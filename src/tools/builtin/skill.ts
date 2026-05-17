/**
 * skill 工具 —— 调用预定义的 AI 技能
 *
 * 此文件仅定义工具的 schema（名称、描述、参数格式）。
 * 实际的执行逻辑在 agent.ts 的 executeSkillTool() 中实现，
 * 因为 fork 模式下需要创建子 Agent 实例，在此处实现会产生循环依赖。
 *
 * 与 agent 工具类似，execute 函数仅作降级提示 ——
 * agent.ts 的工具路由会在到达 executeTool() 之前拦截 "skill" 工具。
 *
 * Skill 的发现和解析由 skills.ts 模块负责。
 */

import type { ToolDefinition } from '../types.js';

export const skillTool: ToolDefinition = {
  definition: {
    name: 'skill',
    description:
      'Invoke a predefined skill (reusable prompt template). ' +
      'Skills are defined in .claude/skills/<name>/SKILL.md. ' +
      'Use this when a task matches a skill\'s trigger conditions.',
    input_schema: {
      type: 'object' as const,
      properties: {
        skill_name: {
          type: 'string',
          description: 'The name of the skill to invoke',
        },
        args: {
          type: 'string',
          description:
            'Optional arguments to pass to the skill (replaces $ARGUMENTS in the prompt template)',
        },
      },
      required: ['skill_name'],
    },
  },
  // 占位执行函数 —— 正常流程中 agent.ts 会在路由层拦截此工具，
  // 此函数仅在工具系统直接调用时作为降级提示。
  execute: () =>
    'Error: skill tool must be handled by the Agent class, not the tool executor.',
};
