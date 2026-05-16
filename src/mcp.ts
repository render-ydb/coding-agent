/**
 * MCP 客户端模块 —— 连接 stdio 方式的 MCP 服务器，发现和转发工具调用
 *
 * MCP（Model Context Protocol）是 Anthropic 推出的开放协议，
 * 允许 AI 应用通过标准化接口连接外部工具和数据源。
 *
 * 本模块实现了 MCP 客户端侧的核心功能：
 * 1. 通过 JSON-RPC 2.0 over stdio 与 MCP 服务器通信
 * 2. 执行 MCP 握手（initialize + notifications/initialized）
 * 3. 发现服务器提供的工具列表（tools/list）
 * 4. 转发工具调用请求并返回结果（tools/call）
 *
 * 架构：
 * ┌──────────┐     JSON-RPC/stdio     ┌───────────────┐
 * │ McpManager│ ──────────────────────> │ MCP Server 1  │
 * │          │ ──────────────────────> │ MCP Server 2  │
 * │          │         ...             │     ...       │
 * └──────────┘                         └───────────────┘
 *
 * 每个 MCP 工具以 "mcp__<serverName>__<toolName>" 格式命名，
 * 避免与内置工具产生名称冲突。
 *
 * 配置来源（按优先级递增，后者覆盖前者）：
 * 1. ~/.claude/settings.json         → 全局配置
 * 2. ${cwd}/.claude/settings.json    → 项目级配置
 * 3. ${cwd}/.mcp.json                → Claude Code 约定文件
 *
 * 设计决策：
 * - 不依赖 MCP SDK，使用原生 JSON-RPC 实现，保持零外部依赖
 * - 懒加载：在 Agent 首次 chat() 时才连接服务器
 * - 优雅降级：单个服务器连接失败不影响其他服务器和内置工具
 */

import { spawn, type ChildProcess } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createInterface, type Interface } from 'readline';

// ─────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────

/**
 * MCP 服务器配置
 *
 * 来自 settings.json 或 .mcp.json 中的 mcpServers 字段。
 * 每个配置定义如何启动一个 MCP 服务器进程。
 */
interface McpServerConfig {
  /** 可执行文件路径（如 "node"、"npx"、"python"） */
  command: string;
  /** 启动参数列表（如 ["server.js", "--port", "3000"]） */
  args?: string[];
  /** 额外环境变量，会与当前进程的 env 合并 */
  env?: Record<string, string>;
}

/**
 * MCP 工具信息
 *
 * 从服务器的 tools/list 响应中解析出的工具元数据。
 * serverName 字段用于后续路由时定位对应的连接。
 */
interface McpToolInfo {
  /** 工具原始名称（服务器端定义的名称） */
  name: string;
  /** 工具描述（展示给模型，帮助模型决定何时使用此工具） */
  description?: string;
  /** JSON Schema 格式的输入参数定义 */
  inputSchema?: any;
  /** 所属服务器名称（配置中的 key） */
  serverName: string;
}

// ─────────────────────────────────────────────────────────
// McpConnection —— 单个 MCP 服务器连接
// ─────────────────────────────────────────────────────────

/**
 * 管理与单个 MCP 服务器的连接
 *
 * 通过子进程的 stdin/stdout 进行 JSON-RPC 2.0 通信。
 *
 * JSON-RPC 消息格式：
 * - 请求（有 id）：{ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }
 * - 响应（有 id）：{ jsonrpc: "2.0", id: 1, result: {...} }
 * - 通知（无 id）：{ jsonrpc: "2.0", method: "notifications/initialized", params: {} }
 *
 * pending Map 用于关联请求和响应：
 * 发送请求时存入 { id → { resolve, reject } }，
 * 收到响应时通过 id 取出 Promise 并 resolve/reject。
 */
class McpConnection {
  /** MCP 服务器子进程 */
  private process: ChildProcess | null = null;
  /** JSON-RPC 请求 ID 自增计数器 */
  private nextId = 1;
  /**
   * 等待响应的请求映射表
   *
   * key: 请求 ID
   * value: Promise 的 resolve/reject 回调
   * 收到响应时通过 ID 匹配，resolve 或 reject 对应的 Promise
   */
  private pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void }
  >();
  /** readline 接口，逐行解析 stdout 的 JSON-RPC 消息 */
  private rl: Interface | null = null;

  constructor(
    private serverName: string,
    private config: McpServerConfig,
  ) {}

  /**
   * 启动服务器进程并建立 JSON-RPC 通信通道
   *
   * stdio 配置为 ["pipe", "pipe", "pipe"]：
   * - stdin (pipe): 用于向服务器发送 JSON-RPC 请求
   * - stdout (pipe): 用于接收服务器的 JSON-RPC 响应
   * - stderr (pipe): 捕获服务器日志，避免污染主进程的输出
   *
   * readline 逐行解析 stdout，每行是一个完整的 JSON-RPC 消息。
   * 非 JSON 行（如服务器的调试日志）会被静默忽略。
   */
  async connect(): Promise<void> {
    const env = { ...process.env, ...(this.config.env || {}) };
    this.process = spawn(this.config.command, this.config.args || [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    // 逐行解析 stdout 中的 JSON-RPC 消息
    this.rl = createInterface({ input: this.process.stdout! });
    this.rl.on('line', (line: string) => {
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) {
            reject(
              new Error(
                `MCP error ${msg.error.code}: ${msg.error.message}`,
              ),
            );
          } else {
            resolve(msg.result);
          }
        }
      } catch {
        // 忽略非 JSON 行（如服务器的调试日志输出）
      }
    });

    // 静默消费 stderr，避免 buffer 满导致进程阻塞
    this.process.stderr?.on('data', () => {});

    this.process.on('error', (err) => {
      console.error(
        `[mcp:${this.serverName}] process error: ${err.message}`,
      );
    });

    // 进程退出时拒绝所有待处理的请求
    this.process.on('exit', (code) => {
      for (const [, { reject }] of this.pending) {
        reject(
          new Error(
            `MCP server '${this.serverName}' exited with code ${code}`,
          ),
        );
      }
      this.pending.clear();
    });
  }

  /**
   * 发送 JSON-RPC 请求并等待响应
   *
   * 分配自增 ID，写入 stdin，返回 Promise。
   * 响应通过 readline 的 line 事件异步接收，匹配 ID 后 resolve。
   */
  private sendRequest(method: string, params: any = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin?.writable) {
        return reject(
          new Error(`MCP server '${this.serverName}' is not connected`),
        );
      }
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      const msg =
        JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      this.process.stdin.write(msg);
    });
  }

  /**
   * 发送 JSON-RPC 通知（无 ID，不期望响应）
   *
   * MCP 协议要求在 initialize 握手后发送 notifications/initialized，
   * 这是一个通知而非请求，不需要等待响应。
   */
  private sendNotification(method: string, params: any = {}): void {
    if (!this.process?.stdin?.writable) return;
    const msg = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
    this.process.stdin.write(msg);
  }

  /**
   * 执行 MCP 初始化握手
   *
   * MCP 协议要求客户端在连接后：
   * 1. 发送 initialize 请求（声明协议版本和客户端能力）
   * 2. 收到响应后发送 notifications/initialized 通知
   *
   * 完成握手后，服务器才会接受 tools/list 和 tools/call 请求。
   */
  async initialize(): Promise<void> {
    await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'coding-agent', version: '1.0.0' },
    });
    this.sendNotification('notifications/initialized');
  }

  /**
   * 发现服务器提供的工具列表
   *
   * 调用 tools/list 方法，将响应映射为 McpToolInfo 数组。
   * serverName 字段标记工具来源，用于后续路由。
   */
  async listTools(): Promise<McpToolInfo[]> {
    const result = await this.sendRequest('tools/list');
    if (!result?.tools || !Array.isArray(result.tools)) return [];
    return result.tools.map((t: any) => ({
      name: t.name,
      description: t.description || '',
      inputSchema: t.inputSchema,
      serverName: this.serverName,
    }));
  }

  /**
   * 调用服务器上的工具
   *
   * MCP 工具调用的返回格式：
   *   { content: [{ type: "text", text: "..." }, ...] }
   *
   * 提取所有 type="text" 的内容块，用换行连接。
   * 如果没有文本内容，则 JSON 序列化整个结果作为回退。
   *
   * @param name 工具原始名称（不含 mcp__ 前缀）
   * @param args 工具输入参数
   */
  async callTool(name: string, args: any): Promise<string> {
    const result = await this.sendRequest('tools/call', {
      name,
      arguments: args,
    });
    if (result?.content && Array.isArray(result.content)) {
      return result.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n');
    }
    return JSON.stringify(result);
  }

  /**
   * 关闭连接并杀掉服务器进程
   *
   * 在 McpManager.disconnectAll() 中调用，
   * 或在初始化失败时清理已启动的进程。
   */
  close(): void {
    this.rl?.close();
    this.process?.kill();
    this.process = null;
  }
}

// ─────────────────────────────────────────────────────────
// McpManager —— 管理所有 MCP 服务器连接
// ─────────────────────────────────────────────────────────

/**
 * MCP 管理器 —— Agent 与 MCP 生态的桥梁
 *
 * 职责：
 * 1. 从配置文件加载 MCP 服务器定义
 * 2. 建立和管理到各服务器的连接
 * 3. 汇总所有服务器的工具定义（添加命名空间前缀）
 * 4. 根据前缀路由工具调用到正确的服务器
 *
 * 工具命名约定：
 *   mcp__<serverName>__<toolName>
 *   例如：mcp__github__create_issue
 *
 * 使用双下划线 __ 作为分隔符，因为：
 * - 单下划线 _ 在工具名中很常见，会导致歧义
 * - 双下划线在工具名中极少出现
 * - 解析时从第二个 __ 开始 join，正确处理工具名中含 __ 的情况
 */
export class McpManager {
  /** 活跃的服务器连接（serverName → McpConnection） */
  private connections = new Map<string, McpConnection>();
  /** 所有已发现的工具列表 */
  private tools: McpToolInfo[] = [];
  /** 幂等标志，防止重复连接 */
  private connected = false;

  /**
   * 加载配置并连接所有 MCP 服务器
   *
   * 幂等操作：首次调用后 connected 标志置 true，后续调用直接返回。
   *
   * 流程：
   * 1. 从三个配置来源加载并合并服务器配置
   * 2. 逐一连接每个服务器：spawn → initialize → listTools
   * 3. 每步都有 15 秒超时保护，避免阻塞 Agent 启动
   * 4. 单个服务器失败时记录日志并跳过，不影响其他服务器
   */
  async loadAndConnect(): Promise<void> {
    if (this.connected) return;
    this.connected = true;

    const configs = this.loadConfigs();
    if (Object.keys(configs).length === 0) return;

    /** 初始化和工具发现的超时时间（毫秒） */
    const TIMEOUT_MS = 15_000;

    for (const [name, config] of Object.entries(configs)) {
      const conn = new McpConnection(name, config);
      try {
        await conn.connect();
        // 初始化握手（带超时保护）
        await Promise.race([
          conn.initialize(),
          new Promise((_, rej) =>
            setTimeout(() => rej(new Error('timeout')), TIMEOUT_MS),
          ),
        ]);
        // 工具发现（带超时保护）
        const serverTools = await Promise.race([
          conn.listTools(),
          new Promise<McpToolInfo[]>((_, rej) =>
            setTimeout(() => rej(new Error('timeout')), TIMEOUT_MS),
          ),
        ]);
        this.connections.set(name, conn);
        this.tools.push(...serverTools);
        console.error(
          `[mcp] Connected to '${name}' — ${serverTools.length} tools`,
        );
      } catch (err: any) {
        console.error(
          `[mcp] Failed to connect to '${name}': ${err.message}`,
        );
        conn.close();
      }
    }
  }

  /**
   * 获取所有 MCP 工具的定义（Anthropic Tool 格式）
   *
   * 返回的工具名带有 mcp__<serverName>__ 前缀，
   * 可以直接与内置工具的 toolDefinitions 数组拼接后发送给 API。
   */
  getToolDefinitions(): Array<{
    name: string;
    description: string;
    input_schema: any;
  }> {
    return this.tools.map((t) => ({
      name: `mcp__${t.serverName}__${t.name}`,
      description:
        t.description || `MCP tool ${t.name} from ${t.serverName}`,
      input_schema: t.inputSchema || { type: 'object', properties: {} },
    }));
  }

  /**
   * 判断工具名是否为 MCP 工具
   *
   * 通过 mcp__ 前缀快速识别，O(1) 时间复杂度。
   * 在 Agent 的工具执行循环中用于路由判断。
   */
  isMcpTool(name: string): boolean {
    return name.startsWith('mcp__');
  }

  /**
   * 路由工具调用到对应的 MCP 服务器
   *
   * 解析前缀格式 mcp__<serverName>__<toolName>：
   * - parts[0] = "mcp"（固定前缀）
   * - parts[1] = serverName
   * - parts[2:] = toolName（join 回 __，处理工具名本身含 __ 的情况）
   *
   * @param prefixedName 带前缀的完整工具名
   * @param args         工具输入参数
   * @returns            工具执行结果（文本）
   */
  async callTool(prefixedName: string, args: any): Promise<string> {
    const parts = prefixedName.split('__');
    if (parts.length < 3) {
      throw new Error(`Invalid MCP tool name: ${prefixedName}`);
    }
    const serverName = parts[1];
    const toolName = parts.slice(2).join('__');
    const conn = this.connections.get(serverName);
    if (!conn) {
      throw new Error(`MCP server '${serverName}' not connected`);
    }
    return conn.callTool(toolName, args);
  }

  /**
   * 断开所有 MCP 服务器连接
   *
   * 杀掉所有子进程，清空连接和工具列表。
   * 重置 connected 标志，允许后续重新连接。
   */
  async disconnectAll(): Promise<void> {
    for (const [, conn] of this.connections) {
      conn.close();
    }
    this.connections.clear();
    this.tools = [];
    this.connected = false;
  }

  // ─── 配置加载（私有方法）─────────────────────────────

  /**
   * 从三个来源加载并合并 MCP 服务器配置
   *
   * 优先级递增（后者覆盖前者同名服务器）：
   * 1. ~/.claude/settings.json        — 全局用户配置（仅读 mcpServers 字段）
   * 2. ${cwd}/.claude/settings.json   — 项目级配置（仅读 mcpServers 字段）
   * 3. ${cwd}/.mcp.json               — MCP 专用文件（mcpServers 字段或根对象）
   *
   * settings.json 是通用配置文件，包含 statusLine、enabledPlugins 等无关字段，
   * 必须严格只读 mcpServers 字段，否则其他含 command 字段的配置项会被误判为 MCP 服务器。
   * .mcp.json 是 MCP 专用文件，允许根对象直接作为服务器映射。
   */
  private loadConfigs(): Record<string, McpServerConfig> {
    const merged: Record<string, McpServerConfig> = {};

    // settings.json 文件：严格只读 mcpServers 字段
    const globalPath = join(homedir(), '.claude', 'settings.json');
    this.mergeConfigFile(globalPath, merged, true);

    const projectPath = join(process.cwd(), '.claude', 'settings.json');
    this.mergeConfigFile(projectPath, merged, true);

    // .mcp.json：MCP 专用文件，允许根对象回退
    const mcpJsonPath = join(process.cwd(), '.mcp.json');
    this.mergeConfigFile(mcpJsonPath, merged, false);

    return merged;
  }

  /**
   * 从单个配置文件中合并 MCP 服务器定义
   *
   * @param filePath    配置文件路径
   * @param target      合并目标对象
   * @param strictKey   为 true 时仅读取 mcpServers 字段（settings.json 模式）；
   *                    为 false 时允许回退到根对象（.mcp.json 模式）
   *
   * settings.json 中可能包含 statusLine、enabledPlugins 等配置项，
   * 其中 statusLine 也有 command 字段，会被 isValidConfig 误判。
   * strictKey=true 确保只从 mcpServers 字段中读取，避免误读。
   */
  private mergeConfigFile(
    filePath: string,
    target: Record<string, McpServerConfig>,
    strictKey: boolean,
  ): void {
    if (!existsSync(filePath)) return;
    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
      // strictKey 模式：仅读取 mcpServers 字段，不回退到根对象
      const servers = strictKey ? raw.mcpServers : (raw.mcpServers || raw);
      if (!servers || typeof servers !== 'object') return;
      for (const [name, config] of Object.entries(servers)) {
        if (this.isValidConfig(config)) {
          target[name] = config as McpServerConfig;
        }
      }
    } catch {
      // 配置文件格式错误时静默跳过
    }
  }

  /**
   * 验证服务器配置的有效性
   *
   * 最低要求：必须是对象且包含 command 字符串字段。
   * args 和 env 是可选的，不影响有效性判断。
   */
  private isValidConfig(config: any): boolean {
    return (
      config &&
      typeof config === 'object' &&
      typeof config.command === 'string'
    );
  }
}
