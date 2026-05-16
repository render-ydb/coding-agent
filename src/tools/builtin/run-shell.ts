/**
 * run_shell 工具 —— 执行 shell 命令
 *
 * 用于 git 操作、npm 命令、运行测试等需要 shell 的场景。
 * stdio 设为 pipe 而非 inherit，确保输出被捕获返回给模型。
 */

import { execSync } from 'node:child_process';
import type { ToolDefinition } from '../types.js';

export const runShell: ToolDefinition = {
  definition: {
    name: 'run_shell',
    description:
      'Execute a shell command. Use for git, npm, tests, etc. NOT for file read/write.',
    input_schema: {
      type: 'object' as const,
      properties: {
        command: { type: 'string', description: 'Shell command to run' },
        timeout: {
          type: 'number',
          description: 'Timeout in ms (default: 30000)',
        },
      },
      required: ['command'],
    },
  },

  execute(input) {
    try {
      return (
        execSync(input.command, {
          encoding: 'utf-8',
          maxBuffer: 5 * 1024 * 1024, // 5MB 输出上限
          timeout: input.timeout || 30000,
          stdio: ['pipe', 'pipe', 'pipe'],
        }) || '(no output)'
      );
    } catch (e: any) {
      const stderr = e.stderr ? `\nStderr: ${e.stderr}` : '';
      const stdout = e.stdout ? `\nStdout: ${e.stdout}` : '';
      return `Failed (exit ${e.status})${stdout}${stderr}`;
    }
  },
};
