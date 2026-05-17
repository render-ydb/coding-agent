/**
 * tool_search 工具 —— 搜索并激活延迟加载的工具
 *
 * 动态工具过滤系统的核心组件。工作流程：
 *
 * 1. 模型通过 system prompt 知道存在哪些 deferred 工具（仅工具名）
 * 2. 当需要使用某个 deferred 工具时，调用 tool_search 搜索
 * 3. tool_search 按关键词模糊匹配 deferred 工具的名称和描述
 * 4. 匹配到的工具被"激活"（加入 activatedTools 集合）
 * 5. 后续 API 请求中会包含被激活工具的完整 schema
 *
 * 此文件仅定义工具的 schema。
 * 实际的搜索和激活逻辑在 tools/index.ts 的 searchAndActivateTools() 中实现，
 * 因为激活状态（activatedTools Set）是模块级状态，不属于单个工具。
 *
 * 设计考量：
 * - 这个工具本身不是 deferred 的（模型需要随时能调用它来激活其他工具）
 * - execute 函数是占位符 —— agent.ts 的工具路由不会拦截此工具，
 *   而是通过 executeTool() → toolMap 正常路由到 index.ts 中注册的 handler
 */

import type { ToolDefinition } from '../types.js';

export const toolSearch: ToolDefinition = {
  definition: {
    name: 'tool_search',
    description:
      'Search for available tools by name or keyword. ' +
      'Returns full schema definitions for matching deferred tools and activates them for use. ' +
      'Use this when you need a tool that is listed as available but not yet active.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Tool name or search keywords to match against tool names and descriptions',
        },
      },
      required: ['query'],
    },
  },
  // 实际执行由 tools/index.ts 中注册的 searchAndActivateTools() 处理，
  // 因为它需要访问模块级的 activatedTools 状态和 builtinTools 注册表。
  execute: () =>
    'Error: tool_search should be routed through the tool executor.',
};
