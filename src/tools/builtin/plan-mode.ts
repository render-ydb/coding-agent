/**
 * Plan Mode 工具 —— 进入/退出规划模式
 *
 * 这两个工具允许模型在对话中动态切换 Plan Mode：
 * - enter_plan_mode: 进入只读规划阶段，模型只能读代码和写 plan 文件
 * - exit_plan_mode:  完成规划后退出，触发用户交互式审批流程
 *
 * 设计说明：
 * execute 函数只是占位（返回提示文本），实际逻辑由 Agent.executePlanModeTool()
 * 拦截处理。这是因为 plan mode 的状态（permissionMode、systemPrompt、审批回调）
 * 都属于 Agent 级别，不适合在纯工具层处理。
 */

import type { ToolDefinition } from '../types.js';

/**
 * enter_plan_mode 工具
 *
 * 模型调用此工具表示希望进入规划阶段：
 * - 停止所有编辑和执行
 * - 切换到只读模式探索代码
 * - 将设计方案写入 plan 文件
 */
export const enterPlanMode: ToolDefinition = {
  definition: {
    name: 'enter_plan_mode',
    description:
      'Enter plan mode to switch to a read-only planning phase. In plan mode, you can only read files and write to the plan file. Use this when you need to explore the codebase and design an implementation plan before making changes.',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },
  execute: () => '[Plan mode tool - handled by Agent]',
};

/**
 * exit_plan_mode 工具
 *
 * 模型调用此工具表示规划完成，准备提交给用户审批：
 * - Agent 读取 plan 文件内容
 * - 展示给用户审批（通过 planApprovalFn 回调）
 * - 根据用户选择决定后续动作（执行/修改/手动审批）
 */
export const exitPlanMode: ToolDefinition = {
  definition: {
    name: 'exit_plan_mode',
    description:
      'Exit plan mode after you have finished writing your plan to the plan file. The user will review and approve the plan before you proceed with implementation.',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },
  execute: () => '[Plan mode tool - handled by Agent]',
};
