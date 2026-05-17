/**
 * frontmatter — 简易 YAML 前置元数据解析器
 *
 * 用于记忆系统的 .md 文件解析。每个记忆文件格式如下：
 *
 *   ---
 *   name: 记忆名称
 *   description: 一行描述
 *   type: user|feedback|project|reference
 *   ---
 *
 *   记忆正文内容...
 *
 * 设计原则：
 * - 不引入第三方 YAML 解析库，仅处理扁平 key: value 对
 * - 容错：缺少 frontmatter 时返回空 meta + 原始内容作为 body
 * - 值不做类型转换，统一返回字符串
 */

/**
 * Frontmatter 解析结果
 *
 * @property meta  解析出的键值对（key → value 均为字符串）
 * @property body  去掉 frontmatter 后的正文部分（已 trim）
 */
export interface FrontmatterResult {
  meta: Record<string, string>;
  body: string;
}

/**
 * 解析 Markdown 文件中的 YAML frontmatter
 *
 * 算法：
 * 1. 检查第一行是否为 "---"（frontmatter 开始标记）
 * 2. 从第二行开始查找下一个 "---"（frontmatter 结束标记）
 * 3. 在两个标记之间，按行解析 "key: value" 对
 * 4. 结束标记之后的内容为 body
 *
 * 边界情况处理：
 * - 第一行不是 "---" → 整个内容作为 body，meta 为空
 * - 找不到结束 "---" → 同上（视为无 frontmatter）
 * - 某行没有冒号 → 跳过该行
 * - key 或 value 为空 → key 为空时跳过，value 为空时保留空字符串
 *
 * @param content  完整的文件内容字符串
 * @returns        解析后的 { meta, body }
 */
export function parseFrontmatter(content: string): FrontmatterResult {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') return { meta: {}, body: content };

  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) return { meta: {}, body: content };

  const meta: Record<string, string> = {};
  for (let i = 1; i < endIdx; i++) {
    const colonIdx = lines[i].indexOf(':');
    if (colonIdx === -1) continue;
    const key = lines[i].slice(0, colonIdx).trim();
    const value = lines[i].slice(colonIdx + 1).trim();
    if (key) meta[key] = value;
  }

  const body = lines.slice(endIdx + 1).join('\n').trim();
  return { meta, body };
}

/**
 * 将 meta 键值对和 body 格式化为带 frontmatter 的 Markdown
 *
 * 输出格式：
 *   ---
 *   key1: value1
 *   key2: value2
 *   ---
 *
 *   body content
 *
 * @param meta  要写入 frontmatter 的键值对
 * @param body  正文内容
 * @returns     完整的带 frontmatter 的文件内容
 */
export function formatFrontmatter(
  meta: Record<string, string>,
  body: string,
): string {
  const lines = ['---'];
  for (const [key, value] of Object.entries(meta)) {
    lines.push(`${key}: ${value}`);
  }
  lines.push('---');
  lines.push('');
  lines.push(body);
  return lines.join('\n');
}
