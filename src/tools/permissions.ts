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

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

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
// 权限规则引擎（配置文件驱动）
// ─────────────────────────────────────────────────────────

/**
 * 解析后的权限规则
 *
 * 规则格式（settings.json 中的字符串）：
 * - "run_shell"            → 匹配所有 run_shell 调用（tool="run_shell", pattern=null）
 * - "run_shell(npm test)"  → 精确匹配命令 "npm test"（tool="run_shell", pattern="npm test"）
 * - "run_shell(npm *)"     → 通配符匹配所有 npm 开头的命令（tool="run_shell", pattern="npm *"）
 * - "write_file(src/*)"    → 通配符匹配 src/ 目录下的文件写入
 */
interface ParsedRule {
  tool: string;
  pattern: string | null;
}

/**
 * 权限规则集合
 *
 * deny 规则优先级高于 allow，即同一操作同时匹配 allow 和 deny 时，结果为 deny。
 * 这是安全优先原则：宁可误拒也不误放。
 */
interface PermissionRules {
  allow: ParsedRule[];
  deny: ParsedRule[];
}

/** 缓存已加载的规则，避免每次 checkPermission 都读磁盘 */
let cachedRules: PermissionRules | null = null;

/**
 * 解析单条规则字符串为结构化对象
 *
 * 支持两种格式：
 * - "tool_name"          → { tool: "tool_name", pattern: null }（匹配所有调用）
 * - "tool_name(pattern)" → { tool: "tool_name", pattern: "pattern" }（匹配特定参数）
 */
function parseRule(rule: string): ParsedRule {
  const match = rule.match(/^([a-z_]+)\((.+)\)$/);
  if (match) {
    return { tool: match[1], pattern: match[2] };
  }
  return { tool: rule, pattern: null };
}

/**
 * 安全读取 JSON 配置文件
 *
 * 文件不存在或解析失败时返回 null，不抛异常。
 * 配置文件损坏不应阻塞 Agent 主流程。
 */
function loadSettings(filePath: string): any {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * 从配置文件加载权限规则
 *
 * 加载顺序（后者追加，不覆盖）：
 * 1. 用户级：~/.coding-agent/settings.json
 * 2. 项目级：{cwd}/.coding-agent/settings.json
 *
 * 配置文件格式：
 * {
 *   "permissions": {
 *     "allow": ["run_shell(npm *)", "run_shell(npx *)"],
 *     "deny": ["run_shell(rm *)"]
 *   }
 * }
 *
 * 两个文件中的 allow/deny 规则会合并到同一个列表中。
 * 进程生命周期内缓存结果，不重复加载。
 */
export function loadPermissionRules(): PermissionRules {
  if (cachedRules) return cachedRules;

  const allow: ParsedRule[] = [];
  const deny: ParsedRule[] = [];

  const userSettings = loadSettings(
    join(homedir(), '.coding-agent', 'settings.json'),
  );
  const projectSettings = loadSettings(
    join(process.cwd(), '.coding-agent', 'settings.json'),
  );

  for (const settings of [userSettings, projectSettings]) {
    if (!settings?.permissions) continue;
    if (Array.isArray(settings.permissions.allow)) {
      for (const r of settings.permissions.allow) allow.push(parseRule(r));
    }
    if (Array.isArray(settings.permissions.deny)) {
      for (const r of settings.permissions.deny) deny.push(parseRule(r));
    }
  }

  cachedRules = { allow, deny };
  return cachedRules;
}

/**
 * 判断单条规则是否匹配当前工具调用
 *
 * 匹配逻辑：
 * 1. tool 名称必须完全匹配
 * 2. 如果规则没有 pattern（如 "read_file"），匹配该工具的所有调用
 * 3. 如果有 pattern，与工具的关键参数比较：
 *    - run_shell → input.command
 *    - 其他工具 → input.file_path
 * 4. pattern 以 * 结尾时做前缀匹配（通配符），否则精确匹配
 */
function matchesRule(
  rule: ParsedRule,
  toolName: string,
  input: Record<string, any>,
): boolean {
  if (rule.tool !== toolName) return false;
  if (!rule.pattern) return true;

  let value = '';
  if (toolName === 'run_shell') value = input.command || '';
  else if (input.file_path) value = input.file_path;
  else return true;

  if (rule.pattern.endsWith('*')) {
    return value.startsWith(rule.pattern.slice(0, -1));
  }
  return value === rule.pattern;
}

/**
 * 用配置规则检查权限（在硬编码逻辑之前执行）
 *
 * deny 规则优先于 allow 规则检查。
 * 返回 null 表示没有匹配的规则，交由后续硬编码逻辑处理。
 */
function checkPermissionRules(
  toolName: string,
  input: Record<string, any>,
): 'allow' | 'deny' | null {
  const rules = loadPermissionRules();

  for (const rule of rules.deny) {
    if (matchesRule(rule, toolName, input)) return 'deny';
  }
  for (const rule of rules.allow) {
    if (matchesRule(rule, toolName, input)) return 'allow';
  }
  return null;
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
 * 2. 配置文件规则（deny 优先于 allow）→ 覆盖后续所有逻辑
 * 3. 读操作 → 始终放行（读文件不会造成破坏）
 * 4. plan mode 工具 → 始终放行（enter/exit_plan_mode）
 * 5. plan 模式 → 仅允许写 plan 文件，拒绝其他所有写操作
 * 6. acceptEdits 模式 → 放行文件编辑
 * 7. 危险 shell 命令 → 需确认（dontAsk 模式下直接拒绝）
 * 8. 写入/编辑不存在的文件 → 需确认
 * 9. 其他 → 放行
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

  // 配置文件规则检查（deny 优先于 allow，匹配后直接返回，跳过后续硬编码逻辑）
  const ruleResult = checkPermissionRules(toolName, input);
  if (ruleResult === 'deny') {
    return { action: 'deny', message: `Denied by permission rule for ${toolName}` };
  }
  if (ruleResult === 'allow') {
    return { action: 'allow' };
  }

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

  // 写入或编辑不存在的文件：需确认或自动拒绝
  if (
    (toolName === 'write_file' || toolName === 'edit_file') &&
    !existsSync(input.file_path)
  ) {
    const verb = toolName === 'write_file' ? 'write' : 'edit';
    if (mode === 'dontAsk') {
      return { action: 'deny', message: `Auto-denied (dontAsk mode): ${verb} non-existent file ${input.file_path}` };
    }
    return { action: 'confirm', message: `${verb} non-existent file: ${input.file_path}` };
  }

  return { action: 'allow' };
}
