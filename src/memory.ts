/**
 * memory — 文件级持久化记忆系统 + 语义召回
 *
 * 本模块实现了 4 类记忆的 CRUD 管理和基于 LLM 的语义召回机制：
 *
 * 数据流：
 * ┌────────────┐     ┌─────────────┐     ┌──────────────┐
 * │ 用户输入   │ ──> │ 预取门控    │ ──> │ sideQuery    │
 * │            │     │ (3 重条件)  │     │ (LLM 选择)   │
 * └────────────┘     └─────────────┘     └──────┬───────┘
 *                                                │
 *                                    ┌───────────▼────────────┐
 *                                    │ 读取选中记忆完整内容   │
 *                                    │ 注入到对话上下文       │
 *                                    └────────────────────────┘
 *
 * 存储结构：
 *   ~/.coding-agent/projects/{sha256-hash}/memory/
 *   ├── MEMORY.md              （自动生成的索引文件）
 *   ├── user_role.md           （用户类记忆）
 *   ├── feedback_testing.md    （反馈类记忆）
 *   ├── project_deadline.md    （项目类记忆）
 *   └── reference_docs.md      （引用类记忆）
 *
 * 设计原则：
 * - 零外部依赖：仅使用 Node.js 内置模块 + 现有 Anthropic SDK
 * - 非阻塞：预取异步运行，永远不阻塞主 Agent Loop
 * - 容错：任何单文件损坏不影响整体功能
 * - 预算控制：单文件 4KB、会话总量 60KB 限制
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  statSync,
} from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import { parseFrontmatter, formatFrontmatter } from './frontmatter.js';

// ─────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────

/**
 * SideQuery 函数类型
 *
 * 一个轻量的 LLM 调用接口，由 Agent 提供具体实现。
 * 用于发送记忆清单给模型，让模型选择与当前查询相关的记忆。
 *
 * @param system      系统提示词（告诉模型如何选择记忆）
 * @param userMessage 用户消息（包含查询 + 记忆清单）
 * @param signal      可选的中断信号（用户按 Ctrl+C 时取消）
 * @returns           模型的文本响应（包含 JSON 格式的选中文件名）
 */
export type SideQueryFn = (
  system: string,
  userMessage: string,
  signal?: AbortSignal,
) => Promise<string>;

/**
 * 记忆类型枚举
 *
 * 四种记忆类型对应不同的用途：
 * - user: 用户角色、偏好、知识水平
 * - feedback: 用户纠正和指导（包含 Why + How to apply）
 * - project: 进行中的工作、目标、截止日期、决策
 * - reference: 外部资源指针（URL、工具、仪表板）
 */
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

/**
 * 完整记忆条目
 *
 * 包含 frontmatter 元数据和正文内容的完整记忆记录。
 * 由 listMemories() 返回，用于 /memory 命令展示。
 */
export interface MemoryEntry {
  /** 记忆名称（frontmatter 中的 name 字段） */
  name: string;
  /** 一行描述（用于语义选择时的快速判断） */
  description: string;
  /** 记忆类型 */
  type: MemoryType;
  /** 文件名（不含路径，如 "user_role.md"） */
  filename: string;
  /** 正文内容（去掉 frontmatter 后的部分） */
  content: string;
}

/**
 * 轻量记忆头信息
 *
 * 仅包含 frontmatter 元数据和文件系统信息，不包含完整正文。
 * 用于 scanMemoryHeaders() 的快速扫描，避免读取大文件。
 */
export interface MemoryHeader {
  /** 文件名（不含路径） */
  filename: string;
  /** 文件绝对路径 */
  filePath: string;
  /** 文件最后修改时间（毫秒时间戳） */
  mtimeMs: number;
  /** 描述（从 frontmatter 提取，可能为 null） */
  description: string | null;
  /** 记忆类型（从 frontmatter 提取，无效值时为 undefined） */
  type: MemoryType | undefined;
}

/**
 * 语义召回结果
 *
 * 经模型判断为与当前查询相关的记忆，包含完整内容和展示用的头部文本。
 */
export interface RelevantMemory {
  /** 文件绝对路径（用于会话级去重） */
  path: string;
  /** 完整文件内容（可能被截断到 MAX_MEMORY_BYTES_PER_FILE） */
  content: string;
  /** 文件最后修改时间（用于新鲜度判断） */
  mtimeMs: number;
  /** 展示用头部文本（包含新鲜度警告或年龄标签） */
  header: string;
}

/**
 * 记忆预取句柄
 *
 * 由 startMemoryPrefetch() 返回，允许调用方非阻塞地轮询结果。
 *
 * 使用模式：
 *   const handle = startMemoryPrefetch(...);
 *   // ... 做其他事 ...
 *   if (handle && handle.settled && !handle.consumed) {
 *     handle.consumed = true;
 *     const memories = await handle.promise;
 *   }
 */
export interface MemoryPrefetch {
  /** 异步结果 Promise（resolve 为 RelevantMemory[]） */
  promise: Promise<RelevantMemory[]>;
  /** 是否已完成（resolve 或 reject 后为 true） */
  settled: boolean;
  /** 是否已被消费（调用方读取后置为 true，防止重复消费） */
  consumed: boolean;
}

// ─────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────

/** 有效的记忆类型集合（用于校验 frontmatter 中的 type 字段） */
const VALID_TYPES = new Set<MemoryType>([
  'user',
  'feedback',
  'project',
  'reference',
]);

/** MEMORY.md 索引文件最大行数（超出部分截断） */
const MAX_INDEX_LINES = 200;
/** MEMORY.md 索引文件最大字节数（超出部分截断） */
const MAX_INDEX_BYTES = 25000;
/** 扫描时最多处理的记忆文件数量 */
const MAX_MEMORY_FILES = 200;
/** 单个记忆文件注入时的最大字节数（超出部分截断） */
const MAX_MEMORY_BYTES_PER_FILE = 4096;
/**
 * 单个会话中累计可注入的记忆总字节数
 *
 * 超过此限制后 startMemoryPrefetch() 返回 null，
 * 停止召回新记忆，避免记忆占据过多上下文空间。
 * 60KB ≈ 约 15000 token（按 4 字符/token 估算），
 * 占 200K 上下文窗口的 ~7.5%，是合理的预算。
 */
const MAX_SESSION_MEMORY_BYTES = 60 * 1024;

// ─────────────────────────────────────────────────────────
// 路径与标识
// ─────────────────────────────────────────────────────────

/**
 * 获取当前项目的唯一哈希标识
 *
 * 使用 SHA-256 哈希当前工作目录路径，取前 16 个十六进制字符。
 * 不同的工作目录会得到不同的哈希值，实现项目级记忆隔离。
 *
 * 为什么用路径哈希而非目录名？
 * - 避免特殊字符导致的文件系统问题
 * - 确保唯一性（不同路径下的同名项目不会冲突）
 * - 16 个 hex 字符 = 64 位，碰撞概率极低
 */
function getProjectHash(): string {
  return createHash('sha256').update(process.cwd()).digest('hex').slice(0, 16);
}

/**
 * 获取当前项目的记忆存储目录
 *
 * 路径格式：~/.coding-agent/projects/{hash}/memory/
 * 如果目录不存在则自动创建（包括所有父目录）。
 *
 * @returns 记忆目录的绝对路径
 */
export function getMemoryDir(): string {
  const dir = join(
    homedir(),
    '.coding-agent',
    'projects',
    getProjectHash(),
    'memory',
  );
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 获取 MEMORY.md 索引文件路径
 */
function getIndexPath(): string {
  return join(getMemoryDir(), 'MEMORY.md');
}

// ─────────────────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────────────────

/**
 * 将文本转为 URL/文件名安全的 slug
 *
 * 转换规则：
 * 1. 转小写
 * 2. 非字母数字字符替换为下划线
 * 3. 去除首尾下划线
 * 4. 截断到 40 字符
 *
 * 用于生成记忆文件名：{type}_{slug}.md
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40);
}

// ─────────────────────────────────────────────────────────
// CRUD 操作
// ─────────────────────────────────────────────────────────

/**
 * 列出所有记忆条目
 *
 * 读取记忆目录下所有 .md 文件（排除 MEMORY.md 索引），
 * 解析 frontmatter 提取元数据，按修改时间降序排列。
 *
 * 容错处理：
 * - 缺少必要字段（name/type）的文件被跳过
 * - 无效 type 值降级为 "project"
 * - 文件读取失败的静默跳过
 *
 * @returns 按修改时间降序排列的记忆条目数组
 */
export function listMemories(): MemoryEntry[] {
  const dir = getMemoryDir();
  const files = readdirSync(dir).filter(
    (f) => f.endsWith('.md') && f !== 'MEMORY.md',
  );
  const entries: MemoryEntry[] = [];
  for (const file of files) {
    try {
      const raw = readFileSync(join(dir, file), 'utf-8');
      const { meta, body } = parseFrontmatter(raw);
      if (!meta.name || !meta.type) continue;
      entries.push({
        name: meta.name,
        description: meta.description || '',
        type: (VALID_TYPES.has(meta.type as MemoryType)
          ? meta.type
          : 'project') as MemoryType,
        filename: file,
        content: body,
      });
    } catch {
      /* 跳过损坏的文件 */
    }
  }
  entries.sort((a, b) => {
    try {
      const statA = statSync(join(dir, a.filename));
      const statB = statSync(join(dir, b.filename));
      return statB.mtimeMs - statA.mtimeMs;
    } catch {
      return 0;
    }
  });
  return entries;
}

/**
 * 保存一条记忆到磁盘
 *
 * 文件名格式：{type}_{slugified_name}.md
 * 自动更新 MEMORY.md 索引。
 *
 * @param entry  记忆条目（不含 filename，由本函数生成）
 * @returns      生成的文件名
 */
export function saveMemory(entry: Omit<MemoryEntry, 'filename'>): string {
  const dir = getMemoryDir();
  const filename = `${entry.type}_${slugify(entry.name)}.md`;
  const content = formatFrontmatter(
    { name: entry.name, description: entry.description, type: entry.type },
    entry.content,
  );
  writeFileSync(join(dir, filename), content);
  updateMemoryIndex();
  return filename;
}

/**
 * 删除一条记忆
 *
 * @param filename  要删除的文件名（不含路径）
 * @returns         是否成功删除（文件不存在时返回 false）
 */
export function deleteMemory(filename: string): boolean {
  const filepath = join(getMemoryDir(), filename);
  if (!existsSync(filepath)) return false;
  unlinkSync(filepath);
  updateMemoryIndex();
  return true;
}

// ─────────────────────────────────────────────────────────
// 索引管理
// ─────────────────────────────────────────────────────────

/**
 * 重建 MEMORY.md 索引文件
 *
 * 从当前所有记忆文件生成一个 Markdown 列表。
 * 每次 saveMemory/deleteMemory 后自动调用。
 */
function updateMemoryIndex(): void {
  const memories = listMemories();
  const lines = ['# Memory Index', ''];
  for (const m of memories) {
    lines.push(
      `- **[${m.name}](${m.filename})** (${m.type}) — ${m.description}`,
    );
  }
  writeFileSync(getIndexPath(), lines.join('\n'));
}

/**
 * 加载 MEMORY.md 索引内容（带截断保护）
 *
 * 截断策略（匹配 Claude Code 的限制）：
 * - 超过 200 行时截断并追加提示
 * - 超过 25KB 时截断并追加提示
 *
 * 为什么需要截断？
 * 索引会注入到系统提示中，过大的索引会浪费上下文空间。
 * 200 行对应约 200 条记忆，对大多数项目已足够。
 *
 * @returns 索引内容字符串（可能已截断），文件不存在时返回空字符串
 */
export function loadMemoryIndex(): string {
  const indexPath = getIndexPath();
  if (!existsSync(indexPath)) return '';
  let content = readFileSync(indexPath, 'utf-8');
  const lines = content.split('\n');
  if (lines.length > MAX_INDEX_LINES) {
    content =
      lines.slice(0, MAX_INDEX_LINES).join('\n') +
      '\n\n[... truncated, too many memory entries ...]';
  }
  if (Buffer.byteLength(content) > MAX_INDEX_BYTES) {
    content =
      content.slice(0, MAX_INDEX_BYTES) +
      '\n\n[... truncated, index too large ...]';
  }
  return content;
}

// ─────────────────────────────────────────────────────────
// 轻量扫描（仅读 frontmatter）
// ─────────────────────────────────────────────────────────

/**
 * 扫描记忆目录，仅读取 frontmatter 元数据
 *
 * 性能优化：每个文件只读前 30 行（frontmatter 通常在 5-10 行内），
 * 避免读取大文件的完整内容。结果按修改时间降序排列，限制最多 200 个。
 *
 * 用途：为语义选择器构建记忆清单（manifest），
 * 只需要文件名、描述和时间戳即可让模型做出选择。
 *
 * @returns 按修改时间降序排列的 MemoryHeader 数组（最多 200 个）
 */
export function scanMemoryHeaders(): MemoryHeader[] {
  const dir = getMemoryDir();
  const files = readdirSync(dir).filter(
    (f) => f.endsWith('.md') && f !== 'MEMORY.md',
  );
  const headers: MemoryHeader[] = [];
  for (const file of files) {
    try {
      const filePath = join(dir, file);
      const stat = statSync(filePath);
      const raw = readFileSync(filePath, 'utf-8');
      // 仅解析前 30 行（frontmatter 不会超过此范围）
      const first30 = raw.split('\n').slice(0, 30).join('\n');
      const { meta } = parseFrontmatter(first30);
      headers.push({
        filename: file,
        filePath,
        mtimeMs: stat.mtimeMs,
        description: meta.description || null,
        type: VALID_TYPES.has(meta.type as MemoryType)
          ? (meta.type as MemoryType)
          : undefined,
      });
    } catch {
      /* 跳过损坏的文件 */
    }
  }
  headers.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return headers.slice(0, MAX_MEMORY_FILES);
}

/**
 * 将 MemoryHeader 数组格式化为记忆清单文本
 *
 * 输出格式（每行一条记忆）：
 *   - [user] user_role.md (2025-01-15T10:30:00.000Z): 用户是高级后端工程师
 *   - [project] project_deadline.md (2025-01-14T08:00:00.000Z): Q1 交付截止日期
 *
 * 此清单会发送给模型，让模型根据描述判断哪些记忆与当前查询相关。
 *
 * @param headers  要格式化的记忆头信息数组
 * @returns        格式化后的多行文本
 */
export function formatMemoryManifest(headers: MemoryHeader[]): string {
  return headers
    .map((h) => {
      const tag = h.type ? `[${h.type}] ` : '';
      const ts = new Date(h.mtimeMs).toISOString();
      return h.description
        ? `- ${tag}${h.filename} (${ts}): ${h.description}`
        : `- ${tag}${h.filename} (${ts})`;
    })
    .join('\n');
}

// ─────────────────────────────────────────────────────────
// 新鲜度判断
// ─────────────────────────────────────────────────────────

/**
 * 计算记忆的人类可读年龄
 *
 * @param mtimeMs  文件最后修改时间（毫秒时间戳）
 * @returns        "today"、"yesterday" 或 "N days ago"
 */
export function memoryAge(mtimeMs: number): string {
  const days = Math.max(0, Math.floor((Date.now() - mtimeMs) / 86_400_000));
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

/**
 * 生成记忆新鲜度警告文本
 *
 * 超过 1 天的记忆可能已过时（代码变更、依赖更新等），
 * 需要提醒模型在引用前先验证当前状态。
 *
 * @param mtimeMs  文件最后修改时间
 * @returns        警告文本（1 天内的记忆返回空字符串）
 */
export function memoryFreshnessWarning(mtimeMs: number): string {
  const days = Math.max(0, Math.floor((Date.now() - mtimeMs) / 86_400_000));
  if (days <= 1) return '';
  return `This memory is ${days} days old. Memories are point-in-time observations, not live state — claims about code behavior may be outdated. Verify against current code before asserting as fact.`;
}

// ─────────────────────────────────────────────────────────
// 语义召回（核心算法）
// ─────────────────────────────────────────────────────────

/**
 * 记忆选择器的系统提示词
 *
 * 告诉模型：
 * 1. 你的角色（为 AI 编程助手选择相关记忆）
 * 2. 输入格式（查询 + 记忆清单）
 * 3. 输出格式（JSON 对象，selected_memories 数组）
 * 4. 选择标准（确定有用才选，不确定就不选）
 */
const SELECT_MEMORIES_PROMPT = `You are selecting memories that will be useful to an AI coding assistant as it processes a user's query. You will be given the user's query and a list of available memory files with their filenames and descriptions.

Return a JSON object with a "selected_memories" array of filenames for the memories that will clearly be useful (up to 5). Only include memories that you are certain will be helpful based on their name and description.
- If you are unsure if a memory will be useful, do not include it.
- If no memories would clearly be useful, return an empty array.`;

/**
 * 调用模型进行记忆语义选择
 *
 * 完整流程：
 * 1. 扫描记忆目录获取所有记忆的头信息
 * 2. 过滤掉本会话已展示过的记忆（去重）
 * 3. 将候选记忆格式化为清单文本
 * 4. 通过 sideQuery 发送给模型，让模型选择相关记忆
 * 5. 解析模型返回的 JSON（最多 5 个文件名）
 * 6. 读取选中记忆的完整内容（带截断保护）
 * 7. 为每条记忆生成展示用的头部文本（含新鲜度信息）
 *
 * 容错设计：
 * - sideQuery 失败时静默返回空数组（不阻塞主循环）
 * - AbortSignal 触发时立即返回空数组
 * - JSON 解析失败时返回空数组
 *
 * @param query           用户当前输入的查询
 * @param sideQuery       LLM 调用函数（由 Agent 提供）
 * @param alreadySurfaced 本会话已展示过的记忆路径集合
 * @param signal          可选的中断信号
 * @returns               与查询相关的记忆数组（最多 5 条）
 */
export async function selectRelevantMemories(
  query: string,
  sideQuery: SideQueryFn,
  alreadySurfaced: Set<string>,
  signal?: AbortSignal,
): Promise<RelevantMemory[]> {
  const headers = scanMemoryHeaders();
  if (headers.length === 0) return [];

  // 过滤掉本会话已展示过的记忆
  const candidates = headers.filter((h) => !alreadySurfaced.has(h.filePath));
  if (candidates.length === 0) return [];

  const manifest = formatMemoryManifest(candidates);

  try {
    const text = await sideQuery(
      SELECT_MEMORIES_PROMPT,
      `Query: ${query}\n\nAvailable memories:\n${manifest}`,
      signal,
    );

    // 从模型响应中提取 JSON（可能被 markdown 代码块包裹）
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]);
    const selectedFilenames: string[] = parsed.selected_memories || [];

    // 将文件名映射回候选记忆，读取完整内容
    const filenameSet = new Set(selectedFilenames);
    const selected = candidates.filter((h) => filenameSet.has(h.filename));

    return selected.slice(0, 5).map((h) => {
      let content = readFileSync(h.filePath, 'utf-8');
      // 单文件截断保护
      if (Buffer.byteLength(content) > MAX_MEMORY_BYTES_PER_FILE) {
        content =
          content.slice(0, MAX_MEMORY_BYTES_PER_FILE) +
          '\n\n[... truncated, memory file too large ...]';
      }
      const freshness = memoryFreshnessWarning(h.mtimeMs);
      const headerText = freshness
        ? `${freshness}\n\nMemory: ${h.filePath}:`
        : `Memory (saved ${memoryAge(h.mtimeMs)}): ${h.filePath}:`;

      return { path: h.filePath, content, mtimeMs: h.mtimeMs, header: headerText };
    });
  } catch (err: any) {
    // 记忆召回永远不应阻塞主循环
    if (signal?.aborted) return [];
    console.error(`[memory] semantic recall failed: ${err.message}`);
    return [];
  }
}

// ─────────────────────────────────────────────────────────
// 预取入口
// ─────────────────────────────────────────────────────────

/**
 * 判断查询是否足够实质性（值得触发记忆召回）
 *
 * 门控条件：
 * - 2 个以上中日韩字符（CJK）→ 通过
 * - 包含空格（多词输入）→ 通过
 * - 单个英文单词（如 "hi"、"test"）→ 不通过
 *
 * 为什么需要此门控？
 * 单词输入通常是 REPL 命令或简短问候，没有语义上下文，
 * 触发记忆召回只会浪费 API 调用和 token。
 */
function isQuerySubstantial(query: string): boolean {
  const trimmed = query.trim();
  if (trimmed.length === 0) return false;

  // CJK 字符检测（中文、日文、韩文）
  const cjkRegex = /[一-鿿぀-ヿ가-힯]/g;
  const cjkMatches = trimmed.match(cjkRegex);
  if (cjkMatches && cjkMatches.length >= 2) return true;

  // 多词检测（包含空白字符）
  if (/\s/.test(trimmed)) return true;

  return false;
}

/**
 * 启动异步记忆预取
 *
 * 三重门控（任一不通过则返回 null，不发起调用）：
 * 1. 输入实质性：查询需为多词或含 CJK 字符
 * 2. 会话预算：已注入字节数未超过 60KB 上限
 * 3. 记忆存在性：磁盘上至少有一个 .md 记忆文件
 *
 * 返回的 MemoryPrefetch 句柄允许调用方非阻塞轮询：
 * - settled: 异步操作完成后自动置 true
 * - consumed: 调用方读取后手动置 true（防止重复消费）
 *
 * 生命周期：
 * 1. chat() 入口处调用本函数启动预取
 * 2. while 循环每次迭代检查 handle.settled
 * 3. settled 后消费结果并注入到最后一条 user 消息
 *
 * @param query              用户输入
 * @param sideQuery          LLM 调用函数
 * @param alreadySurfaced    本会话已展示记忆路径集合
 * @param sessionMemoryBytes 本会话已注入字节数
 * @param signal             中断信号
 * @returns                  预取句柄，或 null（门控未通过）
 */
export function startMemoryPrefetch(
  query: string,
  sideQuery: SideQueryFn,
  alreadySurfaced: Set<string>,
  sessionMemoryBytes: number,
  signal?: AbortSignal,
): MemoryPrefetch | null {
  // 门控 1: 输入实质性
  if (!isQuerySubstantial(query)) return null;

  // 门控 2: 会话预算
  if (sessionMemoryBytes >= MAX_SESSION_MEMORY_BYTES) return null;

  // 门控 3: 记忆文件存在性
  const dir = getMemoryDir();
  const hasMemories = readdirSync(dir).some(
    (f) => f.endsWith('.md') && f !== 'MEMORY.md',
  );
  if (!hasMemories) return null;

  const handle: MemoryPrefetch = {
    promise: selectRelevantMemories(query, sideQuery, alreadySurfaced, signal),
    settled: false,
    consumed: false,
  };
  handle.promise
    .then(() => {
      handle.settled = true;
    })
    .catch(() => {
      handle.settled = true;
    });
  return handle;
}

// ─────────────────────────────────────────────────────────
// 注入格式化
// ─────────────────────────────────────────────────────────

/**
 * 将召回的记忆格式化为可注入对话的文本
 *
 * 每条记忆包裹在 <system-reminder> 标签中，
 * 这是 Anthropic API 识别的系统级注入格式。
 *
 * 输出示例：
 *   <system-reminder>
 *   Memory (saved today): /path/to/memory.md:
 *
 *   记忆正文内容...
 *   </system-reminder>
 *
 * @param memories  要注入的记忆数组
 * @returns         格式化后的文本（用双换行分隔多条记忆）
 */
export function formatMemoriesForInjection(memories: RelevantMemory[]): string {
  return memories
    .map(
      (m) =>
        `<system-reminder>\n${m.header}\n\n${m.content}\n</system-reminder>`,
    )
    .join('\n\n');
}

// ─────────────────────────────────────────────────────────
// 系统提示词段落
// ─────────────────────────────────────────────────────────

/**
 * 构建记忆系统的系统提示词段落
 *
 * 此段落会附加到主系统提示词末尾，教会模型：
 * 1. 记忆目录位置
 * 2. 四种记忆类型及其用途
 * 3. 如何创建新记忆（文件格式和命名规则）
 * 4. 什么不应该保存为记忆
 * 5. 当前已有的记忆索引
 *
 * 注意：此函数在 Agent 构造时调用一次，结果嵌入 baseSystemPrompt。
 * 如果会话中用户创建了新记忆，索引部分会变得"过时"，
 * 但模型仍可通过 read_file 读取最新索引。
 *
 * @returns 完整的记忆系统提示词段落
 */
export function buildMemoryPromptSection(): string {
  const index = loadMemoryIndex();
  const memoryDir = getMemoryDir();

  return `# Memory System

You have a persistent, file-based memory system at \`${memoryDir}\`.

## Memory Types
- **user**: User's role, preferences, knowledge level
- **feedback**: Corrections and guidance from the user (include Why + How to apply)
- **project**: Ongoing work, goals, deadlines, decisions
- **reference**: Pointers to external resources (URLs, tools, dashboards)

## How to Save Memories
Use the write_file tool to create a memory file with YAML frontmatter:

\`\`\`markdown
---
name: memory name
description: one-line description
type: user|feedback|project|reference
---
Memory content here.
\`\`\`

Save to: \`${memoryDir}/\`
Filename format: \`{type}_{slugified_name}.md\`

The MEMORY.md index is auto-updated when you write to the memory directory — do NOT update it manually.

## What NOT to Save
- Code patterns or architecture (read the code instead)
- Git history (use git log)
- Anything already in CLAUDE.md
- Ephemeral task details

## When to Recall
When the user asks you to remember or recall, or when prior context seems relevant.
${index ? `\n## Current Memory Index\n${index}` : '\n(No memories saved yet.)'}`;
}
