# Sikong 引擎处理大任务效率分析

> 分析日期：2025-07-16
> 分析目标：`src/core/task_run/engine.rs` (1562 行)、node 生命周期、竞品对比

---

## 1. Resolve 流程分析

### 1.1 标准节点生命周期

```
New → Specify → [Plan → 子节点] → Execute/Combine → Verify → Commit
```

Engine 的 `resolve()` 核心逻辑（engine.rs:130-175）：

```
resolve(node):
  1. 检查 memo 表：如果 key 已缓存，直接 commit → 返回
  2. specify(node)         — 调用 LLM 做范围评估
  3. 检查 should_plan       — 当 plan=NeedsPlanning|Group 且无子节点时为 true
  4. 如果 should_plan:
     a. plan_group(node)   — 调用 LLM 生成子计划
     b. 解析子节点（parallel 或 stage 模式）
     c. 检查所有子节点是否 accepted
     d. combine(node)      — 调用 LLM 合成子节点产物
  5. 如果不 should_plan 且无 candidate:
     execute(node)         — 调用 LLM 执行
  6. verify_and_maybe_commit(node)
```

### 1.2 跳过路径（Skip Paths）

| 条件 | 跳过 | 节省 |
|------|------|------|
| Memo 表命中（相同 ProblemKey） | Specify → Plan → Execute/Combine → Verify | 全部 4+ 次 LLM 调用 |
| 已有 candidate（重试路径） | Execute | 1 次 LLM 调用 |
| stop_after_route_depth 触发 | Plan / Execute 之后的步骤 | 可控截断 |
| 子节点返回 None（无 artifact） | Combine | 1 次 LLM 调用 |
| Verify 返回 Accept 后的 retry | 重新执行 | 走 handle_reject 重试路径 |

**关键发现**：并非每个节点必须走完 4 个操作。Skip 路径是存在的，但实际触发频率低——memo 表只在相同 ProblemKey 重复出现时命中；stop_after_route_depth 只在 eval/调试模式使用。

### 1.3 串行阻塞点

子节点等待父节点 Combine 是 **聚合式阻塞**（convergent blocking），不是普通队列阻塞：

- `stage` 模式：子节点逐个串行解析（`for child_id in child_ids { resolve(child_id) }`），每个子节点完成后父节点才能继续。5 个 stage = 至少 5 次串行 LLM 调用。
- `parallel` 模式：子节点通过 `JoinSet` 并行执行，但父节点的 Combine 等待 **所有** 子节点 accepted 后才触发。一个慢子节点阻塞整个管道。
- `all_children_accepted` 检查：如果任一子节点没有被 accepted（返回 None），父节点进入 `Pruned` 或 `WaitingForInfo` 状态，整支子树停等。

### 1.4 子节点退出信号

当子节点 resolve 返回 `None`（例如子节点 Verify 失败、WaitingForInfo、Pruned），调用链往回传播：

```
子节点 resolve() 返回 None
  → resolve 循环检测到 None，标记 mark_parent_blocked_by_children
  → 父节点状态变为 Pruned 或 WaitingForInfo
  → 父节点返回 Ok(None)
  → 递归向上传播
```

这个机制保证了故障隔离，但也意味着 **一个分支失败可能级联废弃整棵子树的工作**。

---

## 2. 瓶颈分析

### 2.1 LLM 延迟（主要瓶颈）

| 操作 | 平均 LLM 延迟 | 说明 |
|------|--------------|------|
| Specify | 2-5s | 仅需输出 scope_assessment，但仍是完整 LLM 调用 |
| Plan | 5-15s | 需要分析问题、生成子计划，最大延迟 |
| Execute | 10-60s+ | 实际执行工作，含文件读写、工具调用 |
| Combine | 3-8s | 合成子节点产物 |
| Verify | 3-8s | 判断产物质量 |

一个深度为 3 的 stage 树（根 → 3 个 stage → 每个 stage 有 2 个 leaf），总 LLM 等待时间：

```
根: Specify + Plan + Combine + Verify = 4 calls
Stage1: Specify + Execute + Verify = 3 calls
Stage2: Specify + Execute + Verify = 3 calls
Stage3: Specify + Execute + Verify = 3 calls
Leaves (6个): 每个 Specify + Execute + Verify = 18 calls
总计: 31 次 LLM 调用，串行等待 ~200-600秒+
```

### 2.2 操作过多

**每节点最小 LLM 调用开销**：

- 叶子节点（直接执行）：Specify + Execute + Verify = **3 次 LLM 调用**
- 分组节点（需要规划）：Specify + Plan + Combine + Verify = **4 次 LLM 调用**
- 再加上子节点的所有调用

对于包含 10 个文件的代码变更任务，如果分为 3 个 parallel 子节点：

```
根: Specify + Plan + (并行解析3子) + Combine + Verify = 4 + (3*3) = 13 次 LLM 调用
```

其中 Specify 和 Verify 对每个节点都是强制的。即使是最简单的"改一个 typo"任务也需要 3 次 LLM 调用。

### 2.3 并行度不足

**stage 模式**：`for child_id in child_ids { self.resolve(child_id) }` 完全串行。即使 stage 之间没有数据依赖，也必须按顺序执行。

**parallel 模式**：
- 每个分支克隆整个 Engine（`clone()`），含 workspace 和 agent，有一定的内存和启动开销
- `JoinSet` 中所有分支共享同一个 cancellation token，取消是广播式的
- 分支数量受 tokio 任务调度影响，没有显式的并发上限控制
- 合并阶段（`merge_parallel_branch`）本身是串行的：`while let Some(branch) = branches.join_next()`，逐一合并（merge_parallel_branch 约 80 行），id 重映射开销 O(n)

### 2.4 调用次数过多

**嵌套递归问题**：`resolve()` 使用 `#[async_recursion]`，意味着每个节点在栈上保留完整的上下文，直到子树 resolve 完成。深度 > 10 的树可能导致较大的栈内存占用。

**Agent 调用次数 = O(节点数 × 3)**。对于一个有 20 个节点的中型任务树，最少 60 次 LLM 调用。每次调用的 prompt 构建（harness.rs 中的 operation_prompt_sections）都包含完整的 Operation Context JSON，token 浪费在重复的上下文序列化上。

### 2.5 潜在优化机会对比

| 瓶颈 | 影响程度 | 优化潜力 |
|------|---------|---------|
| LLM 延迟 | 极高 | 减少调用次数、并行化 |
| 操作过多 | 高 | 跳过不必要的 Specify/Verify |
| 并行度不足 | 中 | stage 可并行化、动态并发控制 |
| 调用次数过多 | 中 | prompt 缓存、批量操作 |

---

## 3. 竞品处理大任务的方式

### 3.1 Claude Code

**工作方式**：
- 单次连续 agent 会话，使用 MCP 工具集
- 模型在单次会话内自主决定工具调用序列
- 没有显式的递归分解——规划隐含在模型推理中
- 遇到困难时在同一会话中自我修正

**大任务处理**：
- 依赖模型本身的上下文窗口（100K-200K tokens）容纳整个任务
- 通过工具调用收集信息、修改文件、验证
- 无显式分解框架——模型自行决定何时停止并请求新指令

**优势**：无分解开销，单次会话延迟低（1 次 LLM 调用序列）；迭代快
**劣势**：上下文窗口限制；模型可能在大型代码库中丢失状态；无故障隔离

### 3.2 OpenAI Codex / Cursor

**工作方式**：
- 类似 Claude Code：单次 agent 会话 + 工具调用
- Cursor 使用 Composer（多文件编辑）+ Agent 模式
- Codex 强调与 IDE 深度集成

**大任务处理**：
- 依赖模型上下文和工具来管理状态
- Cursor 的规则（.cursorrules）提供项目级上下文
- 无正式递归分解——由模型内部分解

**优势**：IDE 集成好、实时预览
**劣势**：同 Claude Code——无结构化分解保障

### 3.3 Devin / Factory / 类似工具

**工作方式**：
- 使用 plan-then-execute 模式，但粒度更粗
- 通常 1 次规划 + 1 执行会话
- 没有多层递归分解

### 3.4 Sikong 的独特位置

| 维度 | Claude Code/Codex | Sikong |
|------|------------------|--------|
| 分解方式 | 模型内部分解 | 显式递归节点树 |
| 操作粒度 | 单次会话工具调用 | 多节点、多 agent run |
| 故障隔离 | 会话内回退 | 节点级 Pruned/WaitingForInfo |
| 缓存复用 | 无 | Memo 表（ProblemKey） |
| 并行执行 | 无原生支持 | Parallel 模式 JoinSet |
| 确定性验证 | 无 | Verify 操作 + 硬门控 |
| 开销成本 | 低（1 次调用序列） | 高（N 次独立 LLM 调用） |

Sikong 的优势是可靠性和可控性，代价是 **显著的延迟和 token 开销**。

---

## 4. 改进方向

### 改进方向一：轻量级执行路径（Fast Path）

**解决什么问题**：
目前每个叶子节点都需经历 Specify → Execute → Verify 三次 LLM 调用，即使是非常简单的工作（如"改一个 typo"、"返回已知信息"）。这些 trivial 操作不应触发完整的 agent run 循环。

**预计效率提升**：
- 对 `tiny`/`small` 节点的简单任务：从 3 次 LLM 调用 **减少到 1 次**（合并 Execute+Verify）
- 对 `medium` 以上的节点：保留原有完整路径
- 整体任务时间预估减少 **30-50%**（取决于 tiny/small 任务占比）

**改动范围**：
- `engine.rs`：在 `resolve()` 中新增 `should_fast_path()` 判断
- `types.rs`：新增 `NodePlan::FastExecute` 枚举值
- `harness.rs`：新增 `FastExecute` 操作的 prompt 模板，要求代理同时执行并自我验证
- `tools.rs`：新增 `submit_verified_work` 工具，一次性提交产物和验证声明
- 引入 `NodePlan::FastExecute` 映射：在 `plan_from_scope_assessment` 中，WorkSize::Tiny 映射到 FastExecute，Small 可选

**风险/副作用**：
- 自我验证的可靠性不如独立的 Verify 步骤（验证偏见）
- 需要 engine 层提供确定性验证后门（G-CHECK-FAIL）
- 如果 Fast Execute 产物被 Verify 拒绝，回退到完整路径会增加复杂度
- 必须确保写权限节点仍然有适当的变更检测

### 改进方向二：Stage 组件的自适应并行化

**解决什么问题**：
当前 stage 模式完全串行——即使 stage 之间没有数据依赖，也必须等前一个 stage 完成。而实际问题中，很多"看起来有顺序"的阶段其实可以部分重叠：例如"分析模块 A"和"分析模块 B"可以同时进行，虽然"综合报告"阶段需要等两者都完成。

**预计效率提升**：
- 对 3-stage 的任务链：从 T1+T2+T3 到 max(T1,T2)+T3（如果 stage1 和 stage2 可并行）
- 对 4+ stage 的任务：可能减少 **40-60%** 的串行等待时间
- 不会增加 token 开销——只是改变调度顺序

**改动范围**：
- `node.rs`：在 `PlanGroupMode` 中新增 `Adaptive` 模式，或扩展 `Stage` 携带 `parallel_prefix: Vec<usize>` 字段
- `engine.rs`：修改 `resolve` 中 stage 的子节点调度逻辑
  - 解析 Plan 输出，识别无依赖前缀（通过 `requires_prior_results` 判断）
  - 无依赖的子节点并行启动（JoinSet）
  - 有依赖的子节点在依赖解决后立即启动（dag 调度）
- `tools.rs`：`PlanItemInput` 的 `requires_prior_results` 字段已存在，可直接复用

**风险/副作用**：
- 调度逻辑复杂化——从线性 for 循环到 DAG 调度器
- 并行分支的 Engine clone 成本（每个分支克隆 workspace + agent）
- 错误处理：一个并行分支失败时，需要决定是否取消同级其他分支
- 资源竞争：过多并行分支可能导致文件系统冲突（对 GitFileSystem 工作区尤为敏感）

### 改进方向三：增量 Verify 与确定性预检查短路

**解决什么问题**：
Verify 是每个节点的强制 LLM 调用，即使确定性检查已经可以做出判断。目前 `deterministic_verification_verdict()` 只检查写权限越界和 path 越界这 2 种情况，大量可以用确定性规则判断的场景被遗漏。

**预计效率提升**：
- 约 **20-40%** 的 Verify 调用可以被确定性检查短路
- 对纯内存工作区（Memory provider）的 Verify：确定性检查可以覆盖更多场景
- 每次短路节省 3-8 秒 LLM 延迟 + token 成本

**改动范围**：
- `engine.rs`：扩展 `deterministic_verification_verdict()` 函数
  - 新增内容模式匹配：如果 artifact 是 JSON/YAML 但意图要求 Markdown，直接拒绝
  - 新增大小阈值检查：如果 Execute 产物为空或过短，直接拒绝（FailureClass::IncompleteOutput）
  - 新增 workspace provider 检查：Memory provider 的 Verify 可使用更严格的确定性规则
  - 新增 key 匹配：如果 intent 的关键词和 artifact 内容的关键词不匹配（基本的语义锚检查）
- `types.rs`：如果新增规则需要新的 FailureClass 变体
- **可策略化**：新增 `VerificationStrategy` 枚举（`DeterministicOnly | AgentOnly | Hybrid`），让节点可以声明验证策略

**风险/副作用**：
- 过度严格的确定性规则可能导致合法产物被误拒
- 确定性规则的正确性需要充分的单元测试（目前在 types.rs 中有大量的测试，pattern 可以沿用）
- LLM 产物的形式多样性使得模式匹配不那么可靠——规则必须是宽松的（宽松则减少短路收益）
- 引入 `VerificationStrategy` 会增加节点模板的复杂度
- 需要逐步 rollout：先作为软检查（记录但不拒绝），验证准确率后再转为硬拒绝

---

## 总结

Sikong 的递归引擎在 **可靠性、可控性、故障隔离** 方面显著优于 Claude Code/Codex 等单次会话工具，但代价是 **更高的延迟和 token 成本**。

三个改进方向的核心思路：

1. **Fast Path** — 对小任务合并操作，减少 LLM 调用次数
2. **Adaptive Stage** — 识别并行机会，减少串行等待
3. **Incremental Verify** — 用确定性检查替代部分 LLM Verify 调用

这三个改进方向可以独立实施，也可以组合使用。建议按 **Fast Path → Incremental Verify → Adaptive Stage** 的顺序迭代，因为前两个改动范围小、风险可控、收益直接可测量。
