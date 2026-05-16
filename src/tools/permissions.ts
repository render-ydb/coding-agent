/**
 * 权限系统 —— 控制工具执行的安全门禁
 *
 * 职责：
 * 1. 检测危险 shell 命令（isDangerous）
 * 2. 根据权限模式决定工具是否可执行（checkPermission）
 *
 * 权限检查在工具实际执行之前进行（拦截模式），
 * 而非在执行后撤销（这对文件操作来说不可行）。
 */

import { existsSync } from 'node:fs';

// ─────────────────────────────────────────────────────────
// 权限模式
// ─────────────────────────────────────────────────────────

/**
 * 权限模式枚举
 *
 * 控制工具执行时的权限确认行为，从最宽松到最严格：
 * - bypassPermissions: 跳过所有确认提示（--yolo 模式）
 * - acceptEdits:       自动批准文件编辑，但危险 shell 命令仍需确认
 * - default:           默认模式，危险操作和新文件写入需要用户确认
 * - plan:              只读模式，禁止所有写操作
 * - dontAsk:           自动拒绝所有需要确认的操作（CI/CD 环境）
 */
export type PermissionMode =
  | 'bypassPermissions'
  | 'acceptEdits'
  | 'default'
  | 'plan'
  | 'dontAsk';

// ─────────────────────────────────────────────────────────
// 危险命令检测
// ─────────────────────────────────────────────────────────

/**
 * 危险 shell 命令的正则模式列表
 *
 * 匹配到这些模式的命令会触发用户确认（default 模式），
 * 或被自动拒绝（dontAsk 模式）。
 *
 * \b 是单词边界，防止误匹配（如 "grep" 不会匹配 /\brm\s/）。
 * \s 要求关键字后跟空格，避免匹配到变量名（如 $rmdir）。
 */
const DANGEROUS_PATTERNS = [
  /\brm\s/,                                      // 删除文件
  /\bgit\s+(push|reset|clean|checkout\s+\.)/,    // 危险的 git 操作
  /\bsudo\b/,                                    // 提权
  /\bmkfs\b/,                                    // 格式化文件系统
  /\bdd\s/,                                      // 磁盘写入
  />\s*\/dev\//,                                  // 写入设备文件
  /\bkill\b/,                                    // 杀进程
  /\bpkill\b/,                                   // 按名杀进程
  /\breboot\b/,                                  // 重启
  /\bshutdown\b/,                                // 关机
  // Windows 危险命令
  /\bdel\s/i,              // Windows 删除文件（等同于 rm）
  /\brmdir\s/i,            // Windows 删除目录（等同于 rm -r）
  /\bformat\s/i,           // Windows 格式化磁盘（等同于 mkfs）
  /\btaskkill\s/i,         // Windows 杀进程（等同于 kill）
  /\bRemove-Item\s/i,      // PowerShell 删除文件/目录（等同于 rm -rf）
  /\bStop-Process\s/i,     // PowerShell 杀进程（等同于 kill）
];

export function isDangerous(command: string): boolean {
  return DANGEROUS_PATTERNS.some((p) => p.test(command));
}

// ─────────────────────────────────────────────────────────
// 权限检查
// ─────────────────────────────────────────────────────────

/** 只读工具集合 —— 始终允许执行 */
const READ_ONLY_TOOLS = new Set(['read_file', 'list_files', 'grep_search']);

/** 编辑工具集合 —— 在 acceptEdits 模式下自动批准 */
const EDIT_TOOLS = new Set(['write_file', 'edit_file']);

/**
 * 统一权限检查函数
 *
 * 根据工具名、参数和当前权限模式，决定操作应该：
 * - "allow":   直接执行，无需确认
 * - "confirm": 需要用户手动确认后才执行
 * - "deny":    直接拒绝，不执行
 *
 * 检查优先级（从高到低）：
 * 1. bypassPermissions 模式 → 全部放行
 * 2. 读操作 → 始终放行（读文件不会造成破坏）
 * 3. plan 模式 → 拒绝所有非读操作
 * 4. acceptEdits 模式 → 放行文件编辑
 * 5. 危险 shell 命令 → 需确认（dontAsk 模式下直接拒绝）
 * 6. 新文件写入 → 需确认
 * 7. 其他 → 放行
 */
export function checkPermission(
  toolName: string,
  input: Record<string, any>,
  mode: PermissionMode,
): 'allow' | 'confirm' | 'deny' {
  if (mode === 'bypassPermissions') return 'allow';

  if (READ_ONLY_TOOLS.has(toolName)) return 'allow';

  if (mode === 'plan') return 'deny';

  if (mode === 'acceptEdits' && EDIT_TOOLS.has(toolName)) return 'allow';

  if (toolName === 'run_shell' && isDangerous(input.command)) {
    return mode === 'dontAsk' ? 'deny' : 'confirm';
  }

  if (toolName === 'write_file' && !existsSync(input.file_path)) {
    return mode === 'dontAsk' ? 'deny' : 'confirm';
  }

  return 'allow';
}
