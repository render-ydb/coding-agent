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

/** Plan mode 专属工具 —— 始终允许执行（由 Agent 内部拦截处理） */
const PLAN_MODE_TOOLS = new Set(['enter_plan_mode', 'exit_plan_mode']);

/**
 * 权限检查结果
 *
 * 结构化返回值，包含动作和可选的描述信息：
 * - action "allow":   直接执行，无需确认
 * - action "confirm": 需要用户手动确认后才执行，message 为确认描述
 * - action "deny":    直接拒绝，不执行，message 为拒绝原因
 *
 * 使用结构化对象而非简单字符串的好处：
 * 1. 调用方无需自行拼装确认描述（如命令内容、文件路径）
 * 2. deny 时可以携带拒绝原因，方便展示和调试
 * 3. 扩展性强，未来可添加更多元数据（如规则来源）
 */
export interface PermissionResult {
  action: 'allow' | 'confirm' | 'deny';
  /** 确认描述（confirm 时）或拒绝原因（deny 时） */
  message?: string;
}

/**
 * 统一权限检查函数
 *
 * 根据工具名、参数和当前权限模式，决定操作应该放行、确认还是拒绝。
 * 返回结构化结果 { action, message? }，message 携带上下文信息
 * 供调用方直接用于展示或记录。
 *
 * 检查优先级（从高到低）：
 * 1. bypassPermissions 模式 → 全部放行
 * 2. 读操作 → 始终放行（读文件不会造成破坏）
 * 3. plan mode 工具 → 始终放行（enter/exit_plan_mode）
 * 4. plan 模式 → 仅允许写 plan 文件，拒绝其他所有写操作
 * 5. acceptEdits 模式 → 放行文件编辑
 * 6. 危险 shell 命令 → 需确认（dontAsk 模式下直接拒绝）
 * 7. 新文件写入 → 需确认
 * 8. 其他 → 放行
 *
 * @param toolName      工具名称
 * @param input         工具输入参数
 * @param mode          当前权限模式
 * @param planFilePath  plan 模式下唯一允许写入的文件路径（可选）
 */
export function checkPermission(
  toolName: string,
  input: Record<string, any>,
  mode: PermissionMode,
  planFilePath?: string,
): PermissionResult {
  if (mode === 'bypassPermissions') return { action: 'allow' };

  if (READ_ONLY_TOOLS.has(toolName)) return { action: 'allow' };

  // plan mode 工具（enter/exit）在任何模式下都允许
  if (PLAN_MODE_TOOLS.has(toolName)) return { action: 'allow' };

  // plan 模式：仅允许编辑 plan 文件，其他写操作全部拒绝
  if (mode === 'plan') {
    if (EDIT_TOOLS.has(toolName)) {
      const filePath = input.file_path || input.path;
      if (planFilePath && filePath === planFilePath) return { action: 'allow' };
      return { action: 'deny', message: `Blocked in plan mode: ${toolName} on ${filePath}` };
    }
    if (toolName === 'run_shell') {
      return { action: 'deny', message: 'Shell commands blocked in plan mode' };
    }
    return { action: 'deny', message: `Blocked in plan mode: ${toolName}` };
  }

  if (mode === 'acceptEdits' && EDIT_TOOLS.has(toolName)) return { action: 'allow' };

  // 危险 shell 命令：需确认或自动拒绝
  if (toolName === 'run_shell' && isDangerous(input.command)) {
    if (mode === 'dontAsk') {
      return { action: 'deny', message: `Auto-denied (dontAsk mode): ${input.command}` };
    }
    return { action: 'confirm', message: input.command };
  }

  // 写入不存在的文件：需确认或自动拒绝
  if (toolName === 'write_file' && !existsSync(input.file_path)) {
    if (mode === 'dontAsk') {
      return { action: 'deny', message: `Auto-denied (dontAsk mode): write new file ${input.file_path}` };
    }
    return { action: 'confirm', message: `write new file: ${input.file_path}` };
  }

  return { action: 'allow' };
}
