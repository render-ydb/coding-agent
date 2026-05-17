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
export type { PermissionMode } from './permissions.js';

// ── Re-export 类型 ──
export type { ToolDefinition } from './types.js';

// ─────────────────────────────────────────────────────────
// 工具定义（供 API 调用使用）
// ─────────────────────────────────────────────────────────

/**
 * 所有工具的 Anthropic Tool 定义数组
 *
 * 从注册的 ToolDefinition 中提取 definition 字段。
 * 随每次 API 请求发送给模型，模型据此决定是否/如何调用工具。
 */
export const toolDefinitions: Anthropic.Tool[] = builtinTools.map(
  (t) => t.definition,
);

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
