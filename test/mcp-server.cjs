/**
 * 最小 MCP 测试服务器
 *
 * 实现 JSON-RPC 2.0 over stdio，提供 3 个测试工具：
 * - echo: 回显输入文本
 * - add: 两数相加
 * - timestamp: 返回当前时间戳
 *
 * 用法：node test/mcp-server.cjs
 */

const readline = require("readline");

const rl = readline.createInterface({ input: process.stdin });

const TOOLS = [
  {
    name: "echo",
    description: "Echo back the input text",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "Text to echo" } },
      required: ["text"],
    },
  },
  {
    name: "add",
    description: "Add two numbers together",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "number", description: "First number" },
        b: { type: "number", description: "Second number" },
      },
      required: ["a", "b"],
    },
  },
  {
    name: "timestamp",
    description: "Get the current Unix timestamp",
    inputSchema: { type: "object", properties: {} },
  },
];

function handleRequest(msg) {
  const { id, method, params } = msg;

  // 通知类型（无 id），静默忽略
  if (id === undefined) return null;

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "test-mcp-server", version: "1.0.0" },
      },
    };
  }

  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  }

  if (method === "tools/call") {
    const toolName = params.name;
    const args = params.arguments || {};
    let text;

    switch (toolName) {
      case "echo":
        text = `Echo: ${args.text}`;
        break;
      case "add":
        text = `Result: ${Number(args.a) + Number(args.b)}`;
        break;
      case "timestamp":
        text = `Timestamp: ${Date.now()}`;
        break;
      default:
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Unknown tool: ${toolName}` },
        };
    }

    return {
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text }] },
    };
  }

  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Unknown method: ${method}` },
  };
}

rl.on("line", (line) => {
  try {
    const msg = JSON.parse(line);
    const response = handleRequest(msg);
    if (response) {
      process.stdout.write(JSON.stringify(response) + "\n");
    }
  } catch {
    // 忽略非 JSON 输入
  }
});
