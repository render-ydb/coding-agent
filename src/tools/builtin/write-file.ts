/**
 * write_file 工具 —— 写入文件（完整覆盖）
 *
 * 自动创建不存在的父目录。
 * 适用于创建新文件或完全重写文件内容。
 * 对于局部修改，应使用 edit_file 工具。
 */

import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ToolDefinition } from '../types.js';

export const writeFile: ToolDefinition = {
  definition: {
    name: 'write_file',
    description:
      'Write content to a file. Creates parent directories if needed.',
    input_schema: {
      type: 'object' as const,
      properties: {
        file_path: { type: 'string', description: 'Path to the file' },
        content: { type: 'string', description: 'Content to write' },
      },
      required: ['file_path', 'content'],
    },
  },

  execute(input) {
    try {
      const dir = dirname(input.file_path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(input.file_path, input.content);
      const lineCount = input.content.split('\n').length;
      return `Wrote ${input.file_path} (${lineCount} lines)`;
    } catch (e: any) {
      return `Error: ${e.message}`;
    }
  },
};
