/**
 * edit_file 工具 —— 精确字符串替换编辑
 *
 * 核心机制：在文件中查找 old_string 的精确匹配，替换为 new_string。
 *
 * 安全约束：
 * - old_string 必须在文件中唯一（出现恰好 1 次），否则拒绝操作。
 *   这防止了模型意外修改多处代码的风险。
 * - 使用 split/join 而非 String.replace()，避免 $ 等特殊字符问题。
 *   例如 "$1" 在 replace 中会被当作捕获组引用。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import type { ToolDefinition } from '../types.js';

export const editFile: ToolDefinition = {
  definition: {
    name: 'edit_file',
    description:
      'Edit a file by replacing an exact string match. old_string must be unique in the file.',
    input_schema: {
      type: 'object' as const,
      properties: {
        file_path: { type: 'string', description: 'Path to the file' },
        old_string: { type: 'string', description: 'Exact string to find' },
        new_string: { type: 'string', description: 'Replacement string' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },

  execute(input) {
    try {
      const content = readFileSync(input.file_path, 'utf-8');
      if (!content.includes(input.old_string)) {
        return `Error: old_string not found in ${input.file_path}`;
      }
      // 计算匹配次数：split 后的段数 - 1 = 分隔符出现次数
      const count = content.split(input.old_string).length - 1;
      if (count > 1) {
        return `Error: old_string found ${count} times, must be unique.`;
      }
      const newContent = content
        .split(input.old_string)
        .join(input.new_string);
      writeFileSync(input.file_path, newContent);
      return `Edited ${input.file_path}`;
    } catch (e: any) {
      return `Error: ${e.message}`;
    }
  },
};
