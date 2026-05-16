/**
 * read_file 工具 —— 读取文件内容
 *
 * 返回带行号的文件内容，格式如：
 *    1 | import fs from 'fs';
 *    2 | import path from 'path';
 *
 * 行号使模型能精确引用代码位置（如 "第 42 行有 bug"），
 * 这对后续的 edit_file 操作至关重要——模型需要看到准确的上下文
 * 才能构建正确的 old_string 参数。
 */

import { readFileSync } from 'node:fs';
import type { ToolDefinition } from '../types.js';

export const readFile: ToolDefinition = {
  definition: {
    name: 'read_file',
    description: 'Read file contents with line numbers.',
    input_schema: {
      type: 'object' as const,
      properties: {
        file_path: { type: 'string', description: 'Path to the file' },
      },
      required: ['file_path'],
    },
  },

  execute(input) {
    try {
      const content = readFileSync(input.file_path, 'utf-8');
      return content
        .split('\n')
        .map((line, i) => `${String(i + 1).padStart(4)} | ${line}`)
        .join('\n');
    } catch (e: any) {
      return `Error: ${e.message}`;
    }
  },
};
