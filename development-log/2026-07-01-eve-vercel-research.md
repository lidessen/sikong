# Research: Eve.dev 与 Vercel 新框架调研

**日期**: 2026-07-01
**调研范围**: Eve.dev (Vercel Eve) / Vercel Docs / Sikong 现有设计文档
**信息源**: vercel.com/eve, vercel.com/docs/eve, vercel.com/new, Sikong design/philosophy/\*

---

## 1. Eve.dev 是什么？

**Eve** 是 Vercel 推出的 **Agent Framework**（智能体框架）。

> 官方描述："Like Next.js for web apps, but for agents. Markdown for instructions and skills, TypeScript for tools. Durable by default."
> — vercel.com/eve

- **定位**：一个构建 durable（持久化）后端 AI agent 的框架，运行在 Vercel 平台上
- **核心特性**：文件系统优先（filesystem-first），使用 Markdown 定义 agent 的指令和技能，TypeScript 定义工具
- **解决什么问题**：降低 AI agent 开发的门槛，提供类似 Next.js 的开发体验，但目标是 agent 而非网页应用。默认提供持久化、可观测性、部署等基础设施

### 核心架构

Eve 是 Vercel "Agent Stack" 产品线的一部分，与之并列的产品包括：

| 产品             | 定位                                              |
| ---------------- | ------------------------------------------------- |
| **AI SDK**       | 底层 AI 调用 SDK（与 model 交互的标准化接口）     |
| **AI Gateway**   | AI API 网关（代理、缓存、限流、观测）             |
| **Sandbox**      | 安全的代码沙箱执行环境                            |
| **Workflows**    | 工作流引擎（编排多步骤 AI 任务）                  |
| **Eve**          | Agent 框架（用 Markdown + TypeScript 定义 agent） |
| **Vercel Agent** | Vercel 平台自用的部署/运维 agent                  |

---

## 2. Vercel 的新框架是什么？和 Next.js 的关系？

**Eve 本身就是 Vercel 的"新框架"**。

它与 Next.js 的关系：

- **Next.js** = Web 应用的全栈框架（React 页面、服务端渲染、API routes）
- **Eve** = AI Agent 的框架（Markdown 指令、TypeScript 工具、持久化执行）

两者是 **并列关系**，都属于 Vercel 的产品矩阵，但面向不同的用例：

- Next.js 解决"如何构建网页应用"
- Eve 解决"如何构建 AI agent"

Vercel 的总体策略是将 AI Agent 的开发标准化，就像当年 Next.js 标准化了 React 全栈开发一样。

---

## 3. 这些和 Sikong 的关系？

### Sikong 是什么（回顾）

Sikong 是一个 **Rust 驱动的递归任务引擎**（recursive agent engine），核心循环：

```
ProblemNode → Specify → Execute/Plan → child Resolve... → Combine → Verify → Commit
```

其核心哲学是：

> "Agents explore. The system controls state. Only verified evidence becomes durable fact."

Sikong 不是 AI 编码助手、不是聊天产品、不是 CI/CD 系统。它是一个**agent 驱动的开发协调系统**——将确定性状态控制与不确定的模型行为分离。

### 比较分析

| 维度         | Eve (Vercel)                | Sikong                          |
| ------------ | --------------------------- | ------------------------------- |
| **本质**     | Agent 应用框架              | 递归 agent 引擎                 |
| **语言**     | Markdown + TypeScript       | Rust（内核）+ LLM（agent）      |
| **运行平台** | Vercel 云                   | 本地 / 自托管                   |
| **目标用户** | 构建 agent 应用的开发者     | 构建 agent 驱动开发系统的工程师 |
| **核心创新** | Filesystem-first agent 定义 | 递归分治 + 确定性验证           |
| **持久化**   | 平台内置                    | 通过 workspace provider         |
| **自我改进** | 不涉及                      | 核心设计目标（dogfood loop）    |

### 竞争关系还是互补关系？

**更接近互补关系，而非竞争关系。**

原因：

1. **抽象层次不同**：Eve 是面向最终 agent 开发者的框架（更高层），Sikong 是 agent 引擎/编排内核（更低层）
2. **技术栈不同**：Eve 基于 Vercel 云生态（JS/TS），Sikong 基于 Rust 本地执行
3. **目标不同**：Eve 让 agent 开发更简单；Sikong 让 agent 驱动的开发系统更可靠
4. **设计哲学共鸣**：两者都认同"确定性边界"的重要性——Eve 通过 filesystem-first 定义；Sikong 通过验证门（verification gates）

如果 Sikong 未来需要与外部 agent 交互，Eve 构建的 agent 可以作为 Sikong 的"外部 agent"通过 ACP 协议集成。

### 一句话总结

> Eve 是 Vercel 对"如何构建 agent"的回答；Sikong 是对"如何让 agent 可靠地驱动开发系统"的回答。两者是平行的探索，服务于不同的抽象层次。

---

## 4. 可以借鉴的设计思路

### 4.1 Filesystem-first 的指令管理

Eve 使用 Markdown 文件定义 agent 的指令和技能。Sikong 当前将操作提示（operation prompts）硬编码在 Rust harness 中。

**借鉴思路**：考虑将 agent 的 role/instruction 定义从 Rust 代码中移到可配置的 markdown 文件，类似 Eve 的做法。这样可以：

- 降低修改 prompt 的门槛（无需重新编译）
- 支持不同 task type 的自定义指令
- 更容易进行 A/B 测试和版本管理

### 4.2 "Durable by default" 的设计理念

Eve 强调默认持久化。Sikong 已经有 workspace provider 和验证门，但可以强化"默认可靠"的心智模型：

- 使 verification gates 更显式、更易配置
- 让"失败恢复"成为一等公民
- 增加 agent 执行的 checkpoint/replay 能力

### 4.3 工具与指令的分离

Eve 将工具（TypeScript）与指令（Markdown）严格分离。Sikong 当前的工具定义和 prompt 之间也有清晰的边界（terminal tools, schemas），但可以更系统化地：

- 为每种 task type 定义更明确的工具清单和约束
- 在 agent 可见的上下文中提供工具版本信息
- 支持工具的动态发现和注册

### 4.4 产品化思路

Eve 的营销定位非常清晰："Like Next.js for web apps, but for agents." 这种类比降低了认知门槛。

Sikong 可以考虑类似的定位策略：

- "Like a type-safe build system, but for agent-driven development"
- "Rust kernel + LLM agent = reliable augmentation"

### 4.5 平台生态

Vercel 的产品矩阵（AI SDK → AI Gateway → Workflows → Eve）展示了清晰的分层策略。

Sikong 当前的设计（core → harness → common → design）也有类似的分层，但可以更清晰地定义每一层的边界和外部集成点，特别是：

- 与外部 agent 框架的集成协议（已有 ACP）
- 与 CI/CD 系统的集成
- workspace provider 的标准化

---

## 5. 总结

| 问题                  | 答案                                                                                |
| --------------------- | ----------------------------------------------------------------------------------- |
| Eve.dev 是什么？      | Vercel 的 Agent 框架，用 Markdown 定义指令，TypeScript 定义工具，默认持久化         |
| Vercel 新框架是什么？ | Eve 本身就是 Vercel 的新 Agent 框架，与 Next.js 并列但面向不同场景                  |
| 和 Sikong 的关系？    | 互补关系。Eve 面向 agent 应用开发（高层），Sikong 面向 agent 驱动的开发引擎（底层） |
| 设计借鉴？            | Filesystem-first 指令管理、"durable by default"、工具/指令分离、清晰的产品化定位    |

---

_注意：本调研基于公开文档（vercel.com/eve, vercel.com/docs/eve）和 Sikong 设计文档（design/philosophy/）。由于 Eve 是 Vercel 的产品，部分内部架构细节未公开。_
