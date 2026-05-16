/**
 * Session 会话持久化模块
 *
 * 将对话历史保存为 JSON 文件，实现跨会话的对话恢复。
 *
 * 存储位置：~/.coding-agent/sessions/{sessionId}.json
 * 与 tool-results 目录同级（~/.coding-agent/tool-results/）。
 *
 * 设计原则：
 * 1. 纯持久化层 —— 不依赖 Anthropic SDK，messages 类型为 any[]
 * 2. 全部使用同步 fs 操作 —— 与 agent.ts 已有模式一致
 * 3. 每个函数独立 try/catch —— 单个文件损坏不影响其他功能
 * 4. 无锁、无清理、无大小限制 —— 保持简单
 *
 * 数据流：
 *   Agent.autoSave() → saveSession() → 写入 JSON 文件
 *   CLI --resume → getLatestSessionId() → loadSession() → Agent.restoreSession()
 */

import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/** 会话文件存储目录 */
const SESSIONS_DIR = join(homedir(), '.coding-agent', 'sessions');

/**
 * 会话元数据
 *
 * 轻量级信息，用于列出和筛选会话，无需加载完整的 messages 数组。
 * listSessions() 只返回此类型，避免一次性加载所有会话的完整对话历史。
 */
export interface SessionMetadata {
  /** 会话唯一标识（8 字符 UUID 前缀） */
  id: string;
  /** 使用的模型标识符 */
  model: string;
  /** 会话创建时的工作目录 */
  cwd: string;
  /** 会话创建时间（ISO 8601 格式），用于排序找到最新会话 */
  startTime: string;
  /** 当前消息数量 */
  messageCount: number;
}

/**
 * 完整会话数据
 *
 * 包含元数据 + 完整的对话消息数组。
 * messages 类型为 any[] 而非 Anthropic.MessageParam[]，
 * 这样 session 模块不需要依赖 Anthropic SDK。
 * Agent 在 restoreSession() 中会将其 cast 为正确类型。
 */
export interface SessionData {
  metadata: SessionMetadata;
  /** 对话消息数组（Anthropic MessageParam 格式的 JSON 序列化形式） */
  messages: any[];
}

/**
 * 保存会话到磁盘
 *
 * 将 SessionData 序列化为格式化 JSON 并写入 {SESSIONS_DIR}/{id}.json。
 * 使用 mkdirSync + recursive 确保目录存在（首次运行时自动创建）。
 * 使用 JSON.stringify(data, null, 2) 生成人类可读的格式（方便调试）。
 *
 * 注意：此函数不做 try/catch —— 由调用方（Agent.autoSave()）负责错误处理。
 * 这是有意为之：autoSave 需要知道是否成功，以便决定是否需要重试逻辑。
 *
 * @param id   会话 ID（作为文件名）
 * @param data 完整会话数据（元数据 + 消息数组）
 */
export function saveSession(id: string, data: SessionData): void {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  writeFileSync(join(SESSIONS_DIR, `${id}.json`), JSON.stringify(data, null, 2));
}

/**
 * 按 ID 加载会话
 *
 * 读取指定 ID 的 JSON 文件并反序列化为 SessionData。
 * 失败时返回 null（文件不存在、JSON 格式错误等），不抛出异常。
 *
 * 关于类型安全：JSON.parse 返回的是纯 JS 对象，
 * 结构上与 Anthropic.MessageParam[] 兼容（因为 MessageParam 就是 plain object），
 * Agent.restoreSession() 中通过 `as Anthropic.MessageParam[]` 完成类型断言。
 *
 * @param id 会话 ID
 * @returns  完整会话数据，加载失败返回 null
 */
export function loadSession(id: string): SessionData | null {
  try {
    const raw = readFileSync(join(SESSIONS_DIR, `${id}.json`), 'utf-8');
    return JSON.parse(raw) as SessionData;
  } catch {
    return null;
  }
}

/**
 * 列出所有已保存的会话元数据
 *
 * 扫描 SESSIONS_DIR 下所有 .json 文件，逐个解析并提取 metadata 字段。
 *
 * 双层 try/catch 结构：
 * - 外层：目录不存在时（首次运行）返回空数组
 * - 内层：单个文件损坏时跳过，不影响其他文件的读取
 *
 * @returns 所有有效会话的元数据数组（无特定排序）
 */
export function listSessions(): SessionMetadata[] {
  try {
    const files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
    const results: SessionMetadata[] = [];
    for (const file of files) {
      try {
        const raw = readFileSync(join(SESSIONS_DIR, file), 'utf-8');
        const data = JSON.parse(raw) as SessionData;
        if (data.metadata) results.push(data.metadata);
      } catch {
        // 跳过损坏的文件，不影响其他会话的列出
      }
    }
    return results;
  } catch {
    // 目录不存在（首次运行）或无读取权限
    return [];
  }
}

/**
 * 获取最近一次会话的 ID
 *
 * 通过 listSessions() 获取所有会话，按 startTime 降序排列后返回第一个。
 * startTime 是 ISO 8601 格式（如 "2025-01-15T10:30:00.000Z"），
 * 字符串的字典序比较等价于时间顺序比较，所以直接用 localeCompare。
 *
 * 用于 CLI 的 --resume 功能：无需用户指定会话 ID，自动恢复最近的会话。
 *
 * @returns 最新会话的 ID，无会话时返回 null
 */
export function getLatestSessionId(): string | null {
  const sessions = listSessions();
  if (sessions.length === 0) return null;
  sessions.sort((a, b) => b.startTime.localeCompare(a.startTime));
  return sessions[0].id;
}
