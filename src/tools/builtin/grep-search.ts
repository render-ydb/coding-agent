/**
 * grep_search 工具 —— 正则搜索文件内容
 *
 * 底层调用系统 grep 命令（性能远优于 JS 逐文件扫描）。
 * grep 退出码约定：0=有匹配, 1=无匹配, 2=错误。
 * 限制最多返回 100 行匹配结果。
 */

import { execSync } from 'node:child_process';
import type { ToolDefinition } from '../types.js';

export const grepSearch: ToolDefinition = {
  definition: {
    name: 'grep_search',
    description:
      'Search for a regex pattern in files. Returns matching lines with file paths and line numbers.',
    input_schema: {
      type: 'object' as const,
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search' },
        path: {
          type: 'string',
          description: 'Directory to search (default: current directory)',
        },
        include: {
          type: 'string',
          description: 'File glob filter, e.g. "*.ts"',
        },
      },
      required: ['pattern'],
    },
  },

  execute(input) {
    try {
      const args = ['--line-number', '--color=never', '-r'];
      if (input.include) args.push(`--include=${input.include}`);
      // "--" 标记选项结束，避免 pattern 被误解析为 flag（如 pattern 以 - 开头）
      args.push('--', input.pattern, input.path || '.');

      const result = execSync(`grep ${args.join(' ')}`, {
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024,
        timeout: 10000,
      });
      const lines = result.split('\n').filter(Boolean);
      return (
        lines.slice(0, 100).join('\n') +
        (lines.length > 100 ? `\n... (${lines.length - 100} more)` : '')
      );
    } catch (e: any) {
      // grep 退出码 1 表示无匹配（非错误）
      if (e.status === 1) return 'No matches found.';
      return `Error: ${e.message}`;
    }
  },
};
