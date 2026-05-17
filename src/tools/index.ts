/**
 * 工具系统入口 —— 对外提供统一的工具 API
 *
 * 本模块是 Agent 与工具系统之间的唯一接口。Agent 只需要：
 * 1. toolDefinitions  — 发送给 LLM 的工具描述数组
 * 2. executeTool()    — 根据工具名执行对应逻辑
 * 3. checkPermission  — 执行前的权限检查
 *
 * 目录结构：
 *   tools/
 *   ├── index.ts          ← 本文件（统一出口）
 *   ├── types.ts          ← ToolDefinition 接口
 *   ├── permissions.ts    ← 权限模式、危险检测、checkPermission
 *   └── builtin/          ← 内置工具
 *       ├── index.ts      ← 注册所有内置工具
 *       ├── read-file.ts
 *       ├── write-file.ts
 *       ├── edit-file.ts
 *       ├── list-files.ts
 *       ├── grep-search.ts
 *       └── run-shell.ts
 */

import type Anthropic from '@anthropic-ai/sdk';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { builtinTools } from './builtin/index.js';

// ── Re-export 权限相关 ──
export { checkPermission } from './permissions.js';
export type { PermissionMode, PermissionResult } from './permissions.js';

// ─────────────────────────────────────────────────────────
// 并发安全工具集合
// ─────────────────────────────────────────────────────────

/**
 * 可在流式响应期间安全并发执行的工具集合
 *
 * 这些工具满足两个条件：
 * 1. 无副作用 —— 纯读取操作，不修改文件系统或外部状态
 * 2. 无顺序依赖 —— 多个工具的执行结果互不影响
 *
 * 当 API 流式返回多个 tool_use block 时，属于此集合的工具
 * 会在 content_block_stop 事件触发时立即启动执行，
 * 而非等待整个响应完成后再顺序执行。
 *
 * run_shell 虽然也常用于读取操作，但可能产生副作用（修改文件系统），
 * 因此不纳入并发安全集合。
 */
export const CONCURRENCY_SAFE_TOOLS = new Set([
  'read_file',
  'list_files',
  'grep_search',
]);

// ── Re-export 类型 ──
export type { ToolDefinition } from './types.js';

// ─────────────────────────────────────────────────────────
// 工具定义（供 API 调用使用）
// ─────────────────────────────────────────────────────────

/**
 * 所有工具的 Anthropic Tool 定义数组（完整集合，包含 deferred 工具）
 *
 * 从注册的 ToolDefinition 中提取 definition 字段。
 * 注意：不应直接用于 API 请求 —— 应使用 getActiveToolDefinitions()
 * 过滤掉未激活的 deferred 工具，减少每次调用的 token 开销。
 */
export const toolDefinitions: Anthropic.Tool[] = builtinTools.map(
  (t) => t.definition,
);

// ─────────────────────────────────────────────────────────
// 动态工具过滤（Deferred Tool Activation）
// ─────────────────────────────────────────────────────────

/**
 * 已激活的延迟工具集合（模块级状态）
 *
 * 工作原理：
 * - 标记为 deferred 的工具默认不发送完整 schema 给模型
 * - 模型通过 tool_search 搜索并激活它们后，工具名被加入此集合
 * - getActiveToolDefinitions() 在每次 API 调用前检查此集合
 *
 * 生命周期：
 * - 在整个进程期间持续存在（模块级 Set）
 * - 通过 resetActivatedTools() 重置（会话清理时调用）
 *
 * 为什么不放在 Agent 实例中？
 * - 工具定义是全局共享的（多个子 Agent 可能使用同一个工具集）
 * - 一旦工具被激活，不需要按会话隔离（激活只增不减）
 * - 与 builtinTools 数组保持相同的模块作用域，逻辑内聚
 */
const activatedTools = new Set<string>();

/**
 * 重置已激活工具集合
 *
 * 用于会话清理或测试场景。
 * 调用后所有 deferred 工具回到未激活状态，
 * 下次 API 请求不再包含它们的 schema。
 */
export function resetActivatedTools(): void {
  activatedTools.clear();
}

/**
 * 获取当前活跃的工具定义（发送给 API 的最终列表）
 *
 * 过滤逻辑：
 * - 非 deferred 工具：始终包含
 * - deferred 工具：仅当已在 activatedTools 中时包含
 *
 * 返回的数组不包含 deferred 属性（它不属于 Anthropic.Tool 类型），
 * 通过解构 + rest spread 在 map 中移除。
 *
 * 为什么每次 API 调用都重新过滤而不缓存？
 * - activatedTools 可能在 tool_search 执行后变化
 * - builtinTools 数组不大（~10 个），过滤开销可忽略
 * - 外部可能传入 allTools（子 Agent 的自定义工具集），无法统一缓存
 *
 * @param allTools 可选的自定义工具集（子 Agent 使用），默认使用 builtinTools
 * @returns        过滤后的 Anthropic.Tool 数组，可直接传入 API 的 tools 参数
 */
export function getActiveToolDefinitions(
  allTools?: Anthropic.Tool[],
): Anthropic.Tool[] {
  if (allTools) return allTools;
  return builtinTools
    .filter((t) => !t.deferred || activatedTools.has(t.definition.name))
    .map((t) => t.definition);
}

/**
 * 获取当前未激活的 deferred 工具名列表
 *
 * 用于注入 system prompt，让模型知道哪些工具存在但需要通过
 * tool_search 激活后才能使用。只返回名称（不含 schema），
 * 相比发送完整 schema 节省大量 token。
 *
 * 典型输出示例：["enter_plan_mode", "exit_plan_mode"]
 *
 * @returns 未激活的 deferred 工具名数组（已激活的不再出现）
 */
export function getDeferredToolNames(): string[] {
  return builtinTools
    .filter((t) => t.deferred && !activatedTools.has(t.definition.name))
    .map((t) => t.definition.name);
}

/**
 * 搜索并激活 deferred 工具
 *
 * tool_search 工具的实际执行逻辑。流程：
 * 1. 将查询关键词转小写
 * 2. 在所有 deferred 工具中模糊匹配名称和描述
 * 3. 将匹配到的工具加入 activatedTools 集合
 * 4. 返回匹配工具的完整 schema（JSON 格式），供模型了解参数格式
 *
 * 为什么放在 index.ts 而不是 tool-search.ts？
 * - 需要访问模块级的 activatedTools Set 和 builtinTools 数组
 * - 避免工具定义文件依赖模块级状态，保持工具定义的纯粹性
 *
 * @param query 搜索关键词
 * @returns     匹配工具的 schema 信息（JSON 字符串）或无匹配提示
 */
function searchAndActivateTools(query: string): string {
  const q = query.toLowerCase();
  const deferred = builtinTools.filter((t) => t.deferred);
  const matches = deferred.filter(
    (t) =>
      t.definition.name.toLowerCase().includes(q) ||
      (t.definition.description || '').toLowerCase().includes(q),
  );

  if (matches.length === 0) return 'No matching deferred tools found.';

  for (const m of matches) activatedTools.add(m.definition.name);

  return JSON.stringify(
    matches.map((t) => ({
      name: t.definition.name,
      description: t.definition.description,
      input_schema: t.definition.input_schema,
    })),
    null,
    2,
  );
}

// ─────────────────────────────────────────────────────────
// 工具路由器
// ─────────────────────────────────────────────────────────

/**
 * 根据工具名构建的查找表（Map），O(1) 查找
 *
 * 相比 switch/case 或 Array.find，Map 在工具数量增多时性能更优。
 */
const toolMap = new Map(
  builtinTools.map((t) => [t.definition.name, t.execute]),
);

/**
 * 工具路由器 —— 根据工具名分发到对应的执行函数
 *
 * 这是 Agent Loop 和具体工具之间的桥梁。
 * 所有工具都返回 string，这个约定简化了 agent loop 的逻辑。
 *
 * readFileState 参数（可选）：
 * 用于 Read-before-edit 安全机制。当提供时：
 * - read_file 成功后记录文件的 mtimeMs（最后修改时间戳）
 * - write_file / edit_file 执行前检查：
 *   1. 文件是否曾被读取过（防止盲写）
 *   2. 文件是否在读取后被外部修改过（防止覆盖他人改动）
 * - 写入/编辑成功后更新 mtimeMs，允许后续连续编辑无需重新读取
 *
 * 新建文件（existsSync 为 false）跳过检查，因为没有已有内容需要确认。
 */
export function executeTool(
  name: string,
  input: Record<string, any>,
  readFileState?: Map<string, number>,
): string {
  // tool_search 的执行逻辑在本模块中（需要访问 activatedTools 状态），
  // 不走 toolMap 路由，直接调用 searchAndActivateTools()
  if (name === 'tool_search') {
    return searchAndActivateTools(input.query || '');
  }

  const handler = toolMap.get(name);
  if (!handler) return `Unknown tool: ${name}`;

  // ── Read-before-edit: read_file 成功后记录 mtime ──
  if (name === 'read_file') {
    const result = truncateResult(handler(input));
    if (readFileState && !result.startsWith('Error')) {
      const absPath = resolve(input.file_path);
      try {
        readFileState.set(absPath, statSync(absPath).mtimeMs);
      } catch {}
    }
    return result;
  }

  // ── Read-before-edit: write_file / edit_file 前置检查 ──
  if (name === 'write_file' || name === 'edit_file') {
    const absPath = resolve(input.file_path);
    // 仅对已存在的文件做检查；新建文件无需先读取
    if (readFileState && existsSync(absPath)) {
      if (!readFileState.has(absPath)) {
        return `Error: You must read this file before ${name === 'write_file' ? 'writing' : 'editing'}. Use read_file first to see its current contents.`;
      }
      const currentMtime = statSync(absPath).mtimeMs;
      const recordedMtime = readFileState.get(absPath)!;
      if (currentMtime !== recordedMtime) {
        return `Warning: ${input.file_path} was modified externally since your last read. Please read_file again before ${name === 'write_file' ? 'writing' : 'editing'}.`;
      }
    }
    const result = truncateResult(handler(input));
    // 写入/编辑成功后更新 mtime，允许后续连续编辑
    if (readFileState && !result.startsWith('Error')) {
      try {
        readFileState.set(absPath, statSync(absPath).mtimeMs);
      } catch {}
    }
    return result;
  }

  return truncateResult(handler(input));
}

// ─────────────────────────────────────────────────────────
// 结果截断
// ─────────────────────────────────────────────────────────

/** 工具结果的最大字符数（防止上下文窗口被单个工具结果占满） */
const MAX_RESULT_CHARS = 50000;

/**
 * 截断过长的工具结果
 *
 * 保留头部和尾部各约一半的内容，中间插入截断提示。
 * 头尾同时保留的原因：
 * - 头部通常包含文件开头/命令输出的关键信息
 * - 尾部通常包含错误信息或最终结果
 */
function truncateResult(result: string): string {
  if (result.length <= MAX_RESULT_CHARS) return result;
  const keep = Math.floor((MAX_RESULT_CHARS - 60) / 2);
  return (
    result.slice(0, keep) +
    `\n\n[... truncated ${result.length - keep * 2} chars ...]\n\n` +
    result.slice(-keep)
  );
}
