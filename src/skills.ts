/**
 * Skills 系统 —— 可复用的 AI 提示模板
 *
 * Skill 是存放在 `.claude/skills/<name>/SKILL.md` 中的 Markdown 文件，
 * 包含 YAML frontmatter（元数据）和 prompt 模板（正文）。
 * 可以理解为"AI 的 shell 脚本"：预定义好的指令集，可被用户或模型按需调用。
 *
 * 发现优先级（同名 skill 后者覆盖前者）：
 * 1. 用户级：~/.claude/skills/<name>/SKILL.md
 * 2. 项目级：<cwd>/.claude/skills/<name>/SKILL.md
 *
 * 执行模式：
 * - inline（默认）：将 skill 的 prompt 注入当前对话，模型按指令继续
 * - fork：在隔离的子 Agent 中执行，完成后仅返回结果文本
 *
 * 生命周期：
 * - discoverSkills()：扫描目录，解析文件，缓存结果
 * - getSkillByName()：按名称查找
 * - executeSkill()：解析模板变量，返回可执行的 prompt
 * - buildSkillPromptSection()：生成注入系统提示的 skill 列表
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { parseFrontmatter } from './frontmatter.js';

// ─────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────

/**
 * Skill 定义 —— 从 SKILL.md 解析出的完整信息
 *
 * @property name           技能名称（来自 frontmatter 的 name 字段，或目录名回退）
 * @property description    简短描述（显示在 /skills 列表和系统提示中）
 * @property whenToUse      触发提示（告诉模型何时应该自动调用此 skill）
 * @property allowedTools   fork 模式下子 Agent 可用的工具白名单（为空则使用全部工具）
 * @property userInvocable  用户是否可通过 /<name> 命令直接调用（默认 true）
 * @property context        执行模式："inline" 注入当前对话 / "fork" 隔离子 Agent
 * @property promptTemplate 提示词模板（支持 $ARGUMENTS 和 ${CLAUDE_SKILL_DIR} 变量）
 * @property source         来源："project" 项目级 / "user" 用户级
 * @property skillDir       SKILL.md 所在目录的绝对路径（用于 ${CLAUDE_SKILL_DIR} 替换）
 */
export interface SkillDefinition {
  name: string;
  description: string;
  whenToUse?: string;
  allowedTools?: string[];
  userInvocable: boolean;
  context: 'inline' | 'fork';
  promptTemplate: string;
  source: 'project' | 'user';
  skillDir: string;
}

/**
 * executeSkill() 的返回值
 *
 * 调用方（agent.ts）根据 context 决定后续行为：
 * - inline：将 prompt 作为工具结果返回给模型
 * - fork：用 prompt 作为子 Agent 的系统提示，allowedTools 限制工具集
 */
export interface SkillResult {
  prompt: string;
  allowedTools?: string[];
  context: 'inline' | 'fork';
}

// ─────────────────────────────────────────────────────────
// 缓存
// ─────────────────────────────────────────────────────────

/**
 * Skill 发现结果缓存
 *
 * 进程生命周期内只扫描一次目录。后续调用直接返回缓存。
 * 调用 resetSkillCache() 可清除（测试用）。
 */
let cachedSkills: Map<string, SkillDefinition> | null = null;

// ─────────────────────────────────────────────────────────
// 发现
// ─────────────────────────────────────────────────────────

/**
 * 扫描并发现所有可用的 skill
 *
 * 扫描顺序决定覆盖优先级：
 * 1. 先扫用户级 ~/.claude/skills/（低优先级）
 * 2. 再扫项目级 <cwd>/.claude/skills/（高优先级，同名覆盖）
 *
 * 使用 Map 存储：key 为 skill name，同名后写入的覆盖先写入的，
 * 自然实现了项目级覆盖用户级的优先级语义。
 *
 * @returns 所有已发现的 skill Map（name → SkillDefinition）
 */
export function discoverSkills(): Map<string, SkillDefinition> {
  if (cachedSkills) return cachedSkills;

  const skills = new Map<string, SkillDefinition>();

  // 用户级 skills（低优先级）
  const userDir = join(homedir(), '.claude', 'skills');
  scanSkillDir(userDir, 'user', skills);

  // 项目级 skills（高优先级，同名覆盖用户级）
  const projectDir = join(process.cwd(), '.claude', 'skills');
  scanSkillDir(projectDir, 'project', skills);

  cachedSkills = skills;
  return skills;
}

/**
 * 扫描指定目录下的 skill 子目录
 *
 * 目录结构约定：
 *   <baseDir>/
 *   ├── commit/
 *   │   └── SKILL.md
 *   ├── greet/
 *   │   └── SKILL.md
 *   └── ...
 *
 * 每个子目录必须包含 SKILL.md 文件，否则跳过。
 * 解析出的 skill 以 name（或目录名）为 key 存入 Map。
 *
 * @param baseDir 基础目录路径（用户级或项目级）
 * @param source  来源标记
 * @param skills  目标 Map（会被原地修改）
 */
function scanSkillDir(
  baseDir: string,
  source: 'project' | 'user',
  skills: Map<string, SkillDefinition>,
): void {
  if (!existsSync(baseDir)) return;

  let entries: string[];
  try {
    entries = readdirSync(baseDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return;
  }

  for (const dirName of entries) {
    const skillFile = join(baseDir, dirName, 'SKILL.md');
    if (!existsSync(skillFile)) continue;

    const skill = parseSkillFile(skillFile, dirName, source);
    if (skill) {
      skills.set(skill.name, skill);
    }
  }
}

// ─────────────────────────────────────────────────────────
// 解析
// ─────────────────────────────────────────────────────────

/**
 * 解析单个 SKILL.md 文件为 SkillDefinition
 *
 * 解析流程：
 * 1. 读取文件内容
 * 2. 通过 parseFrontmatter() 提取 YAML 元数据和正文
 * 3. 从 meta 中提取各字段（支持下划线和连字符两种命名风格）
 * 4. 解析 allowed-tools：先尝试 JSON 数组，失败则按逗号分割
 *
 * allowed-tools 的两种格式示例：
 *   JSON:  allowed-tools: ["read_file", "grep_search"]
 *   逗号:  allowed-tools: read_file, grep_search
 *
 * @param filePath SKILL.md 的绝对路径
 * @param dirName  所在目录名（作为 name 的回退值）
 * @param source   来源标记（project / user）
 * @returns        解析后的 SkillDefinition，解析失败返回 null
 */
function parseSkillFile(
  filePath: string,
  dirName: string,
  source: 'project' | 'user',
): SkillDefinition | null {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  const { meta, body } = parseFrontmatter(content);

  // 解析 allowed-tools（支持 JSON 数组或逗号分割）
  const rawAllowedTools = meta['allowed-tools'] || meta['allowed_tools'];
  let allowedTools: string[] | undefined;
  if (rawAllowedTools) {
    try {
      const parsed = JSON.parse(rawAllowedTools);
      if (Array.isArray(parsed)) {
        allowedTools = parsed.map((s: any) => String(s).trim());
      }
    } catch {
      // JSON 解析失败，按逗号分割
      allowedTools = rawAllowedTools
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }

  // user-invocable 默认为 true
  const rawUserInvocable = meta['user-invocable'] || meta['user_invocable'];
  const userInvocable =
    rawUserInvocable === undefined || rawUserInvocable === 'true';

  // context 默认为 inline
  const rawContext = meta['context'];
  const context: 'inline' | 'fork' =
    rawContext === 'fork' ? 'fork' : 'inline';

  return {
    name: meta['name'] || dirName,
    description: meta['description'] || '',
    whenToUse: meta['when-to-use'] || meta['when_to_use'],
    allowedTools,
    userInvocable,
    context,
    promptTemplate: body,
    source,
    skillDir: resolve(filePath, '..'),
  };
}

// ─────────────────────────────────────────────────────────
// 查找
// ─────────────────────────────────────────────────────────

/**
 * 按名称查找 skill
 *
 * 触发 discoverSkills()（如果尚未扫描）。
 *
 * @param name skill 名称
 * @returns    匹配的 SkillDefinition，未找到返回 undefined
 */
export function getSkillByName(name: string): SkillDefinition | undefined {
  return discoverSkills().get(name);
}

// ─────────────────────────────────────────────────────────
// 执行
// ─────────────────────────────────────────────────────────

/**
 * 解析 skill 模板并返回可执行结果
 *
 * 执行步骤：
 * 1. 按名称查找 skill
 * 2. 调用 resolveSkillPrompt() 替换模板变量
 * 3. 返回 { prompt, allowedTools, context }
 *
 * 调用方（agent.ts）根据 context 决定后续：
 * - inline：将 prompt 作为 tool_result 注入对话
 * - fork：创建子 Agent，以 prompt 为系统提示执行
 *
 * @param skillName skill 名称
 * @param args      用户传入的参数字符串（替换模板中的 $ARGUMENTS）
 * @returns         SkillResult 或 null（未找到）
 */
export function executeSkill(
  skillName: string,
  args: string,
): SkillResult | null {
  const skill = getSkillByName(skillName);
  if (!skill) return null;

  const prompt = resolveSkillPrompt(skill, args);

  return {
    prompt,
    allowedTools: skill.allowedTools,
    context: skill.context,
  };
}

/**
 * 解析 skill 的 prompt 模板，替换变量
 *
 * 支持两种变量：
 * - $ARGUMENTS / ${ARGUMENTS}：替换为用户传入的参数字符串
 * - ${CLAUDE_SKILL_DIR}：替换为 SKILL.md 所在目录的绝对路径
 *
 * ${CLAUDE_SKILL_DIR} 的用途：
 * 允许 skill 引用同目录下的辅助文件（模板、配置、脚本等）。
 * 例如 prompt 中写 "Read ${CLAUDE_SKILL_DIR}/template.md"，
 * 模型会自动读取 skill 目录中的 template.md 文件。
 *
 * @param skill 目标 skill 定义
 * @param args  用户参数字符串
 * @returns     替换变量后的最终 prompt
 */
function resolveSkillPrompt(skill: SkillDefinition, args: string): string {
  let prompt = skill.promptTemplate;
  // $ARGUMENTS 和 ${ARGUMENTS} 两种写法都支持
  prompt = prompt.replace(/\$\{?ARGUMENTS\}?/g, args);
  prompt = prompt.replace(/\$\{CLAUDE_SKILL_DIR\}/g, skill.skillDir);
  return prompt;
}

// ─────────────────────────────────────────────────────────
// 系统提示注入
// ─────────────────────────────────────────────────────────

/**
 * 构建注入系统提示的 skill 描述段
 *
 * 将所有发现的 skill 分为两组展示：
 * 1. 用户可调用（user-invocable）：列出 /<name> 命令和描述
 * 2. 模型自动调用（非 user-invocable）：列出名称、描述和触发提示
 *
 * 如果没有发现任何 skill，返回空字符串（不占用系统提示空间）。
 *
 * 输出示例：
 *   # Available Skills
 *
 *   ## User-invocable skills
 *   - /commit — Generate a commit message
 *     When to use: When the user asks to commit changes
 *
 *   ## Auto skills
 *   - review — Review code for issues
 *     When to use: When changes are ready for review
 *
 * @returns 格式化的 skill 描述段，或空字符串
 */
export function buildSkillPromptSection(): string {
  const skills = discoverSkills();
  if (skills.size === 0) return '';

  const userSkills: SkillDefinition[] = [];
  const autoSkills: SkillDefinition[] = [];

  for (const skill of skills.values()) {
    if (skill.userInvocable) {
      userSkills.push(skill);
    } else {
      autoSkills.push(skill);
    }
  }

  const lines: string[] = ['# Available Skills', ''];

  if (userSkills.length > 0) {
    lines.push(
      'The following skills are available. Use the `skill` tool to invoke them when appropriate.',
    );
    lines.push('');
    lines.push('## User-invocable skills');
    for (const s of userSkills) {
      lines.push(`- /${s.name}${s.description ? ` — ${s.description}` : ''}`);
      if (s.whenToUse) {
        lines.push(`  When to use: ${s.whenToUse}`);
      }
    }
    lines.push('');
  }

  if (autoSkills.length > 0) {
    lines.push('## Auto skills');
    for (const s of autoSkills) {
      lines.push(`- ${s.name}${s.description ? ` — ${s.description}` : ''}`);
      if (s.whenToUse) {
        lines.push(`  When to use: ${s.whenToUse}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────
// 工具方法
// ─────────────────────────────────────────────────────────

/**
 * 清除 skill 缓存（测试用）
 *
 * 下次调用 discoverSkills() 时会重新扫描目录。
 * 正常使用中不需要调用此函数。
 */
export function resetSkillCache(): void {
  cachedSkills = null;
}
