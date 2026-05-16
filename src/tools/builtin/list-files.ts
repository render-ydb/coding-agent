/**
 * list_files 工具 —— 递归列出目录下的文件
 *
 * 使用深度优先遍历（DFS），自动跳过常见的大目录
 * （node_modules、.git、dist、.next）。
 * 限制最多返回 500 个文件，防止在大型仓库中产生过多输出。
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolDefinition } from '../types.js';

/** 跳过这些目录以避免输出过多和性能问题 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next']);
const MAX_FILES = 500;

export const listFiles: ToolDefinition = {
  definition: {
    name: 'list_files',
    description:
      'List files in a directory recursively. Skips node_modules and .git.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'Directory to list (default: current directory)',
        },
        pattern: {
          type: 'string',
          description:
            "Glob-like suffix filter, e.g. '.ts' to list only .ts files",
        },
      },
    },
  },

  execute(input) {
    const dir = input.path || '.';
    const results: string[] = [];

    function walk(d: string): void {
      if (results.length >= MAX_FILES) return;
      let entries: string[];
      try {
        entries = readdirSync(d);
      } catch {
        return;
      }
      for (const name of entries) {
        if (SKIP_DIRS.has(name)) continue;
        const full = join(d, name);
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          walk(full);
        } else {
          if (input.pattern && !full.endsWith(input.pattern)) continue;
          results.push(full);
        }
      }
    }

    walk(dir);
    if (results.length === 0) return 'No files found.';
    return (
      results.join('\n') +
      (results.length >= MAX_FILES ? `\n... (truncated at ${MAX_FILES})` : '')
    );
  },
};
