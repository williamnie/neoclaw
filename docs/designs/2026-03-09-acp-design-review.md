# ACP 多编程工具编排技术设计 Review

日期：2026-03-09
审阅人：Claude Code

---

## 总体评价

设计文档结构完整、覆盖面广，从背景、目标、架构、数据模型到安全、可观测性、发布策略都有涉及。作为技术方案初稿，质量不错。以下是需要关注和补充的问题。

---

## 一、与现有代码库的对齐问题

### 1. 工具注册模式不一致

现有工具（`code.ts`, `cron.ts`, `spawn.ts` 等）都使用 `createTool()` + Zod schema 的工厂模式，并在 `neovate-agent.ts` 的 `ensureSession()` 中通过 plugin 注入。设计文档第 7.4 节只提了路径，但没有明确说明要遵循这个模式。

**建议：** 补充说明新增 `acp_run` / `acp_workflow` 工具必须遵循现有 `createTool()` 工厂模式，返回 `{ llmContent, isError }` 结构。

### 2. 配置结构嵌套位置需确认

设计文档 Section 9 提出在 `Config.agent` 下新增 `acp` 配置。当前 `AgentConfig` 接口的字段都是扁平的（`model`, `codeModel`, `workspace` 等），突然加入一个深层嵌套的 `AgentAcpConfig` 对象，风格不一致。

**建议：**
- 方案 A：保持一致，在 `Config` 顶层加 `acp` 字段（与 `agent`, `channels`, `providers` 平级）
- 方案 B：在文档中说明为什么选择嵌套在 `agent` 下
- 需要做出明确选择并说明理由

### 3. 与现有 `SubagentManager` 的关系未说明

当前已有 `src/services/subagent.ts`（`SubagentManager`），它通过 `createSession` 产生独立 coding agent。ACP 的 `AcpExecutor` 在功能上与其有重叠。设计文档完全没提到如何处理与 `SubagentManager` 的关系。

**必须回答：**
- 是否复用 `SubagentManager`？
- 是否替代？
- `spawn` 工具是否会被弃用？
- 两者共存时的职责边界是什么？

### 4. 消息总线集成缺失

现有系统的核心通信机制是 `MessageBus`（`src/bus/message-bus.ts`），所有渠道的消息都通过它路由。设计文档没有说明 ACP 执行结果如何回到消息总线。

**建议：** 参考 `SubagentManager` 的模式（将结果作为 `InboundMessage` 发布回总线），明确 ACP 的消息集成方式。

---

## 二、架构设计的问题

### 5. `acpx` 依赖风险评估不够深入

设计文档承认 `acpx` 是 alpha 阶段，但给出的对策只是"锁定版本、启动自检、兼容层封装"。

**缺失信息：**
- `acpx` 是什么项目？谁维护？什么许可证？需要给出链接或说明
- 如果 `acpx` 停止维护怎么办？需要有备选方案或自研路径的说明
- `acpx` 的 NDJSON 协议是否有稳定规范？如果没有，解析器随时可能因上游变更而崩溃

### 6. 编排层过度设计

`AcpWorkflowOrchestrator` 要实现"DAG 执行、步骤状态机、重试策略、条件分支"——这实际上是一个轻量级工作流引擎。对于 v1 来说范围偏大。

**建议：**
- v1 只支持固定的 `plan-merge-implement-validate` 模板，硬编码流程
- v1.1 再抽象 DAG/条件分支
- 避免一开始就做通用 workflow engine

### 7. `plan_merge` 步骤的具体机制不清楚

Section 6.1 提到 `plan_merge` 由"主 agent 汇总两份方案"，但关键细节缺失。

**需要明确：**
- "主 agent" 是指 Neoclaw 的 `NeovateAgent` 自身吗？
- 汇总逻辑是 LLM 调用还是规则匹配？
- 如果两份方案冲突严重怎么处理？
- 是否需要用户介入确认？

这是整个流程的关键决策点，不应含糊。

---

## 三、数据模型问题

### 8. `AcpRunRequest.permission` 类型范围太窄

```ts
permission?: "approve-all" | "approve-reads" | "deny-all";
```

实际场景中，开发步骤需要写文件权限但不需要网络权限，测试步骤需要执行权限但不需要写权限。三个选项过于粗粒度。

**建议：** 至少预留扩展空间（`string` union 可扩展），或说明当前粒度足以覆盖 v1 场景。

### 9. `WorkflowRunRecord` 缺少关键字段

当前定义缺少以下对运行历史查看和问题排查至关重要的字段：

- `goal` / `prompt`：无法在运行历史中看到原始请求
- `workflowTemplate`：无法知道用的哪个流程模板
- `config` 快照：无法复现运行时的配置状态

---

## 四、安全与运维问题

### 10. cwd 校验规则不明确

Section 13.1 说"cwd 必须通过路径规范化并校验在允许根目录内"，但没有定义"允许根目录"是什么。

**需要明确：** 是 workspace 目录？用户 home？配置文件指定的目录列表？否则实现时会各自理解不同。

### 11. 敏感信息脱敏范围不够

Section 13.2 只提到 `token, secret, apiKey`，但编程工具的输出可能包含：

- 数据库连接字符串
- 环境变量中的凭据
- `.env` 文件内容
- SSH 密钥片段

**建议：** 用正则模式匹配而非关键词列表。

### 12. 并发控制缺少队列机制

Section 11.2 提到 `maxParallelRuns` 全局并发限制，但没有说明超出限制时的行为。

**需要明确：**
- 排队等待？
- 直接拒绝？
- 降级到单步执行？

---

## 五、可观测性问题

### 13. 日志与现有体系不一致

当前系统使用 `logger.ts` 的结构化日志（tag + level），设计文档提出独立的文件日志体系（`workspace/logs/acp/runs/<runId>/`）。

**建议：**
- 关键事件（开始、结束、失败）仍需通过 `logger` 输出，保持统一可观测
- 文件日志是补充的详细执行记录，不是替代
- 在文档中明确这一关系

### 14. 指标写入 `RuntimeStatusStore` 需要扩展接口

当前 `RuntimeStatusStore` 追踪的是 token usage、请求计数、错误列表。新增的 ACP 指标（`acp_runs_total` 等）需要扩展 store 接口和持久化格式，不是简单的"写入"。

**建议：** 在设计中说明对 `RuntimeStatusStore` 的具体改动范围。

---

## 六、缺失的部分

### 15. 没有成本估算与控制机制

多 agent 并行调用意味着 API 成本翻倍甚至更多。设计文档完全没有提到：

- 单次工作流的预期 token 消耗
- 成本上限控制（max tokens per workflow）
- 用户确认机制（预估成本后让用户确认再执行）

### 16. 没有用户交互模型

工作流运行期间的用户交互问题未说明：

- 用户发新消息怎么处理？（排队？打断？忽略？）
- 用户能看到实时进度吗？
- 进度通过什么渠道反馈？（Telegram 消息？CLI 输出？Web dashboard？）

### 17. 没有说明工件的生命周期

`workspace/artifacts/acp-runs/` 下的文件：

- 什么时候清理？
- 占用空间上限？
- 是否需要用户手动管理？
- 是否有自动归档或过期策略？

### 18. 缺少与 memory 系统的集成说明

工作流执行的结果是否应该被记入长期记忆（`MEMORY.md`）？例如"上次用 codex+claude 规划、gemini 实施了一个网站项目，效果不错"。这种经验对后续任务选择 agent 组合很有价值。

**建议：** 说明 ACP 执行结果与 memory/consolidation 系统的集成方式。

---

## 七、建议的优先级调整

设计文档试图一次性覆盖太多内容。建议分三期：

| 阶段 | 范围 | 核心交付 |
|------|------|----------|
| **P0 (v1-beta)** | `AcpExecutor` + `acp_run` 工具 | 单步调用 codex/claude/gemini，结果返回 |
| **P1 (v1-ga)** | `AcpWorkflowOrchestrator` + `acp_workflow` 工具 | 固定模板的"规划-汇总-实施-验证"流程 |
| **P2 (v1.1)** | Web 管理面 + 自定义模板 + DAG | 通用化编排能力 |

P0 先做通单步调用的稳定性和错误处理，这是一切的基础。不要跳过这个阶段直接做编排。

---

## 总结评分

| 维度 | 评分 | 说明 |
|------|------|------|
| 完整性 | 8/10 | 覆盖面广，但缺少成本控制、用户交互、工件生命周期 |
| 与现有系统对齐 | 5/10 | 未充分说明与 SubagentManager、MessageBus、logger 的关系 |
| 可实施性 | 6/10 | 编排层范围偏大，建议分期；acpx 依赖风险需更多说明 |
| 安全性 | 7/10 | 基本面到位，但细节（cwd 校验、脱敏范围、并发溢出）需补充 |
| 渐进性 | 5/10 | 一次性太多，建议明确 P0/P1/P2 分期 |

**核心建议：先把单步 `acp_run` 做稳，再做编排；明确与现有 SubagentManager/MessageBus 的关系；补充 acpx 的具体信息和备选方案。**
