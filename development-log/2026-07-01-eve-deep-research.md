# Eve.dev 深入调研

**日期**: 2026-07-01
**来源**: vercel.com/docs/eve, github.com/vercel/eve (v0.13.0, 2.3k+ stars, Apache-2.0, TypeScript 96.9%), 实际源码分析

---

## Eve 的核心架构

### 项目布局（Filesystem-first）

```
my-agent/
└── agent/
    ├── agent.ts              # 运行时配置 (defineAgent)
    ├── instructions.md       # 系统提示（一直加载）
    ├── tools/                # 每个文件一个工具 (TypeScript + Zod)
    ├── skills/               # 按需加载的过程 (SKILL.md)
    ├── channels/             # 入口点 (HTTP, Slack, Discord)
    ├── subagents/            # 子 agent（专用角色）
    ├── sandbox/              # 隔离计算环境
    ├── connections/          # 外部 MCP/OpenAPI 服务器
    └── schedules/            # 定时任务 (cron)
```

### 运行时

- **Harness** 做一次 AI 工作，决定继续/等待/完成
- **Workflows** 持久化 session 状态（事件日志回放），支持断点续传
- **AI Gateway** 路由模型请求，provider 故障转移
- **Sandbox** 每个 agent 一个隔离的 bash 环境

---

## 与 Sikong 的详细对比

### 1. 子任务分解

| 维度    | Eve                           | Sikong                               |
| ------- | ----------------------------- | ------------------------------------ |
| 机制    | `agent` 工具调用子 agent      | 递归 Plan→Execute→Verify→Combine     |
| 验证    | 无内置验证门                  | 严格的 verification gates            |
| Combine | 无合成阶段                    | Combine 节点合成子结果               |
| 隔离    | 声明子 agent 有独立的 sandbox | 子节点继承 workspace scope（可缩小） |
| 状态    | 子 agent 全新状态             | 子节点继承 context + 资源            |

**Sikong 优势**：有验证和合成，适合复杂任务的可靠执行。
**Eve 可借鉴**：`agent` 工具的 `outputSchema` 参数——子节点返回结构化输出，父节点明确知道格式。

### 2. 提示/指令管理

| 维度   | Eve                                            | Sikong                   |
| ------ | ---------------------------------------------- | ------------------------ |
| 格式   | Markdown 文件                                  | Rust 硬编码字符串        |
| 加载   | `instructions.md` 一直加载，`skills/` 按需加载 | 全部一直加载             |
| 修改   | 改文件即生效（无需编译）                       | 改 Rust → 重新编译       |
| 发现   | 文件系统自动发现                               | 无                       |
| 域特定 | 每个 agent 有自己的 instructions               | 所有节点用同一套 prompts |

**Eve 优势**：Filesystem-first 的指令管理，修改门槛低。
**Sikong 可借鉴（✅）**：把 operation prompts 从 Rust 移到 markdown 文件。
**Sikong 应避免（❌）**：Eve 的 skills 按需加载机制对 Sikong 来说太重。只需要把 prompts 外置即可。

### 3. 工具系统

| 维度 | Eve                                    | Sikong                    |
| ---- | -------------------------------------- | ------------------------- |
| 定义 | TypeScript + Zod schema                | Rust + JSON Schema derive |
| 注册 | 每个文件一个工具，文件名=工具名        | terminal tool 集声明      |
| 类型 | tools（标准）+ connections（MCP 远程） | terminal + non-terminal   |
| 沙箱 | Sandbox 文件系统 + bash                | Workspace provider        |

**Sikong 优势**：terminal/non-terminal 分离是原创设计，让引擎可以判断何时终止。
**Eve 优势**：文件即工具，简单直观。connections 支持 MCP 远程工具。

### 4. 持久化

| 维度 | Eve                    | Sikong                          |
| ---- | ---------------------- | ------------------------------- |
| 机制 | Workflows 事件日志回放 | Task store + workspace snapshot |
| 恢复 | 自动，断点续传         | 手工 replay                     |
| 观测 | Vercel dashboard 内置  | Metrics CLI                     |

**Eve 优势**：断点续传开箱即用。
**Sikong 可借鉴（⚠️）**：事件日志回放模式可以简化 recovery 流程，但会引入复杂的事件排序问题。

### 5. 入口点

| 维度          | Eve                       | Sikong                       |
| ------------- | ------------------------- | ---------------------------- |
| HTTP          | 内置 POST /eve/v1/session | 无（需要 ACP 客户端）        |
| Slack/Discord | 内置 channel 支持         | 无                           |
| CLI           | `npx eve init`            | `siko run`, `siko assistant` |
| ACP           | 无                        | stdin/stdout JSON-RPC        |

**Eve 优势**：多平台入口点开箱即用。
**Sikong 可借鉴（⚠️）**：HTTP 入口对集成 CI/CD 有用，但不是核心功能。

---

## 可以借鉴的设计

### ✅ 1. Filesystem-first 的指令管理

把操作 prompts 从 Rust 硬编码移到 `prompts/` 目录的 markdown 文件中。

```
prompts/
├── specify.md
├── execute.md
├── verify.md
├── plan.md
└── combine.md
```

改动成本低（只涉及 harness.rs 的 prompt 加载），收益高（无需重新编译即可修改 prompts）。

### ✅ 2. `outputSchema` 模式

Eve 的 `agent` 工具的 `outputSchema` 参数让子 agent 返回结构化输出。Sikong 的 terminal tools 已经有 schema 约束了，但可以更明确：

- Execute 阶段让 agent 声明输出的格式
- Verify 阶段按格式校验

### ⚠️ 3. 技能按需加载

Eve 的 skills 只在使用时才加载到上下文。Sikong 当前的 prompt 全部一直加载，token 浪费。
但这需要改进 harness 的 prompt 组装逻辑，需要谨慎——可能打破现有平衡。

### ❌ 4. 平台依赖

Eve 强依赖 Vercel 平台（Function/Workflows/Sandbox/AI Gateway）。
Sikong 是本地/自托管，不应引入平台依赖。

### ❌ 5. Subagent 的全部功能

Eve 的 subagent 支持独立 sandbox、独立工具集、角色独立。
Sikong 的递归分解走不同的路线（验证门 + combine），不宜照搬 subagent 模式。

---

## 结论

Eve 和 Sikong 的定位确实互补：

- **Eve**：面向构建 agent 应用的开发者。通过 filesystem-first 模式降低 agent 开发门槛。
- **Sikong**：面向 agent 驱动的开发引擎。通过递归分解 + 验证门保证复杂任务的可靠执行。

Eve 的 filesystem-first 指令管理是最值得借鉴的设计。
其他方面（subagent、skills 按需加载等）与 Sikong 的分治架构不完全匹配，需要分析后选择性采纳。
