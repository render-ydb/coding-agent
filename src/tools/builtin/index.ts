/**
 * 内置工具注册表
 *
 * 汇集所有内置工具（builtin tools），统一导出。
 * 添加新的内置工具只需两步：
 * 1. 在 builtin/ 目录下创建新文件，导出 ToolDefinition
 * 2. 在本文件中 import 并加入 builtinTools 数组
 */

import type { ToolDefinition } from '../types.js';
import { readFile } from './read-file.js';
import { writeFile } from './write-file.js';
import { editFile } from './edit-file.js';
import { listFiles } from './list-files.js';
import { grepSearch } from './grep-search.js';
import { runShell } from './run-shell.js';

/**
 * 所有内置工具的有序数组
 *
 * 顺序决定了工具在 API 请求中的排列位置。
 * 读操作在前、写操作在后，是一种约定（不影响功能）。
 */
export const builtinTools: ToolDefinition[] = [
  readFile,
  writeFile,
  editFile,
  listFiles,
  grepSearch,
  runShell,
];
