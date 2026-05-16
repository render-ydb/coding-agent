/**
 * 工具系统的共享类型定义
 *
 * 所有内置工具都遵循同一个接口约定：
 * - definition: 发送给 LLM 的工具描述（JSON Schema 格式）
 * - execute:    接收 LLM 生成的参数，执行实际操作，返回字符串结果
 *
 * 这种"定义 + 执行"捆绑的设计使得添加新工具只需：
 * 1. 创建一个新文件，导出 ToolDefinition
 * 2. 在 builtin/index.ts 中注册
 */

import type Anthropic from '@anthropic-ai/sdk';

/**
 * 工具定义接口 —— 将 LLM 侧的描述和本地执行逻辑绑定在一起
 *
 * @property definition - Anthropic Tool 格式的工具描述，随每次 API 请求发送给模型。
 *                        模型根据 name、description 和 input_schema 决定是否/如何调用此工具。
 * @property execute    - 工具的实际执行函数。接收模型生成的参数（已从 JSON 解析），
 *                        返回字符串结果。结果会作为 tool_result 发回给模型。
 *                        无论成功或失败都返回 string（错误信息也是字符串），
 *                        这样模型可以自行解读错误并决定下一步。
 */
export interface ToolDefinition {
  definition: Anthropic.Tool;
  execute: (input: Record<string, any>) => string;
}
