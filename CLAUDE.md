# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

### Code commenting rules

所有新编写的函数、类、接口、模块都必须添加详细的中文注释，包括：

- **模块级**：文件顶部说明模块职责、设计原则、数据流
- **接口/类型**：每个字段说明用途和取值含义
- **函数**：说明功能、参数含义、返回值、关键设计决策（为什么这样做）、边界情况处理
- **复杂逻辑**：在代码段前用注释解释 why（为什么），而非 what（做了什么）

参考 `src/agent.ts` 中已有注释的风格（如 `compactConversation()`、`snipStaleResults()` 等函数的注释）。
