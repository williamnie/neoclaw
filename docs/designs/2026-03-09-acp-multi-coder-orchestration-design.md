# Neoclaw ACP 多编程工具编排技术设计（完整方案）

日期：2026-03-09

## 1. 背景

当前 Neoclaw 已有 `code` 工具，可在单次调用里启动一个独立 coding session 完成代码任务。但该能力有三个限制：

1. 只面向单一模型会话，无法稳定表达“多工具分工协作”。
2. 缺少流程编排语义，无法强约束“先方案评审、再开发、再验收”。
3. 缺少统一会话治理与可观测性，不利于长期运行和故障排查。

用户目标是支持自然语言指令，例如：

“帮我写一个网站，先让 codex 和 claude code 做方案，让 gemini-cli 开发。”

这类需求本质是“多 Agent 编排系统”问题，不是单一工具调用问题。

## 2. 目标

构建一个在 Neoclaw 内可长期运行的 ACP 编排子系统，满足以下能力：

1. 支持 `codex / claude / gemini` 多编程工具统一接入。
2. 支持强流程编排：规划并行、汇总决策、实施、验证、回滚建议。
3. 支持会话持久化、取消、中断恢复、失败重试。
4. 支持完整可观测：事件流、步骤日志、工件追踪、错误分类。
5. 与现有 `memory`、`session`、`web` 配置体系兼容。

## 3. 非目标

1. 不在本期重写 ACP 协议或实现自研 ACP 客户端。
2. 不替代 `code` 工具；`code` 工具继续作为回退路径。
3. 不做“无限自治”任务执行；保持显式步骤与可审计边界。
4. 不引入远程集中式控制平面，仍保持本地优先运行。

## 4. 关键决策

### 4.1 统一执行面：采用 `acpx`

采用 `acpx` 作为 ACP 执行网关，原因：

1. 已支持多 Agent 统一命令面（codex/claude/gemini）。
2. 已支持会话持久化、队列化、取消、JSON 事件输出。
3. 可通过版本锁定降低上游 alpha 变更风险。

### 4.2 编排与执行分层

将系统拆分为两层：

1. 执行层（ACP Runtime）：稳定调用 `acpx`、解析事件、返回结构化结果。
2. 编排层（Workflow Orchestrator）：表达多步骤工作流与故障策略。

### 4.3 使用 `skills` 做策略，不做传输

`skills` 仅用于“如何拆任务、如何选工具、如何输出工件”的策略模板；
真正调用 codex/claude/gemini 由 ACP 工具完成。

### 4.4 默认安全策略

默认权限模式为 `approve-reads`，写操作需显式步骤授权；避免默认高风险写权限。

## 5. 总体架构

```text
User Message
   |
NeovateAgent
   |
ACP Workflow Tool (new)
   |
Workflow Orchestrator -------------------------+
   |                                            |
   +--> ACP Executor (acpx spawn + parser)      |
   |      |                                     |
   |      +--> acpx --format json ...           |
   |                 |                          |
   |                 +--> codex / claude / gemini
   |
   +--> Artifact Store (workspace/artifacts/acp-runs)
   |
   +--> Runtime Status + Logs (workspace/logs/acp)
```

## 6. 目标流程（以“先方案后开发”为例）

### 6.1 标准流程定义

1. `plan_codex`：由 codex 输出方案文档。
2. `plan_claude`：由 claude 输出方案文档。
3. `plan_merge`：主 agent 汇总两份方案，产出统一实现规范。
4. `implement_gemini`：由 gemini 按统一规范实现。
5. `validate`：执行测试/构建/静态检查并生成验收报告。
6. `report`：向用户返回摘要、产出路径、风险与后续建议。

### 6.2 执行策略

1. `plan_codex` 与 `plan_claude` 并行执行，减少总耗时。
2. 汇总阶段必须等待两个规划步骤结束，允许“单失败降级”策略。
3. 开发阶段只读 `implementation-spec` 工件，避免目标漂移。
4. 验证失败时，允许一次自动修复回合，再次验证后给出最终报告。

## 7. 模块设计

### 7.1 `AcpExecutor`（新）

职责：

1. 以参数化方式调用 `acpx`，禁止 shell 拼接注入。
2. 解析 NDJSON 事件流，转换为内部标准事件。
3. 聚合结果、分类错误、返回 `AcpRunResult`。

建议路径：

- `src/services/acp/executor.ts`
- `src/services/acp/parser.ts`
- `src/services/acp/errors.ts`

### 7.2 `AcpSessionRouter`（新）

职责：

1. 将 Neoclaw 会话映射到 acpx session 名称。
2. 统一处理 `sessions ensure/close/status/cancel`。
3. 支持会话过期与软关闭策略。

建议路径：

- `src/services/acp/session-router.ts`

### 7.3 `AcpWorkflowOrchestrator`（新）

职责：

1. 执行工作流 DAG（并行/串行/条件分支）。
2. 管理步骤状态机与重试策略。
3. 产出工件索引和最终摘要。

建议路径：

- `src/services/acp/workflow.ts`
- `src/services/acp/workflow-spec.ts`

### 7.4 Agent Tool 接口（新增）

新增两个工具：

1. `acp_run`：单步骤执行（给普通任务调用）。
2. `acp_workflow`：多步骤编排执行（给复杂任务调用）。

保留现有 `code` 工具做降级兜底。

建议路径：

- `src/agent/tools/acp-run.ts`
- `src/agent/tools/acp-workflow.ts`

## 8. 数据模型

### 8.1 执行请求

```ts
type AcpRunRequest = {
  agent: "codex" | "claude" | "gemini" | string;
  mode: "exec" | "session";
  sessionName?: string;
  cwd: string;
  prompt: string;
  timeoutSec?: number;
  permission?: "approve-all" | "approve-reads" | "deny-all";
  ttlSec?: number;
  noWait?: boolean;
};
```

### 8.2 步骤状态机

```text
pending -> running -> succeeded
                 \-> failed -> retrying -> running
                 \-> cancelled
                 \-> timed_out
                 \-> skipped
```

### 8.3 工件模型

```ts
type WorkflowArtifact = {
  id: string;
  stepId: string;
  kind: "plan" | "spec" | "code-report" | "validation-report" | "log" | "raw-events";
  path: string;
  createdAt: string;
  summary?: string;
};
```

### 8.4 工作流运行记录

```ts
type WorkflowRunRecord = {
  runId: string;
  channel: string;
  chatId: string;
  requestedAt: string;
  startedAt?: string;
  finishedAt?: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  steps: Array<{
    id: string;
    status: string;
    attempts: number;
    agent?: string;
    startedAt?: string;
    finishedAt?: string;
    error?: string;
  }>;
  artifacts: WorkflowArtifact[];
};
```

## 9. 配置设计

在 `Config.agent` 下新增 ACP 配置：

```ts
interface AgentAcpConfig {
  enabled: boolean;
  command: string; // default: "acpx"
  defaultAgent: "codex" | "claude" | "gemini";
  allowedAgents: string[]; // allow-list
  defaultMode: "session" | "exec";
  defaultPermission: "approve-reads" | "approve-all" | "deny-all";
  nonInteractivePermissions: "deny" | "fail";
  timeoutSec: number; // per run default
  ttlSec: number; // queue owner ttl
  maxParallelRuns: number; // global
  maxStepRetries: number;
  retryBackoffMs: number;
  strictJson: boolean;
  autoEnsureSession: boolean;
  fallbackToCodeTool: boolean;
  artifactDir: string; // default: <workspace>/artifacts/acp-runs
  logDir: string; // default: <workspace>/logs/acp
  agentCommandOverrides?: Record<string, string>;
}
```

默认值原则：

1. 安全优先：`defaultPermission=approve-reads`。
2. 稳定优先：`strictJson=true`，减少解析噪声。
3. 可恢复优先：`autoEnsureSession=true`。

## 10. 工具接口设计

### 10.1 `acp_run`

参数：

1. `task`：执行任务描述。
2. `agent`：目标工具。
3. `cwd`：绝对路径，必须在允许目录下。
4. `mode`：`exec | session`。
5. `session_name`：可选。
6. `timeout_sec`：可选覆盖。
7. `permission`：可选覆盖。
8. `output_path`：可选，指定结果工件写入路径。

返回：

1. 最终文本结果摘要。
2. 结构化元数据：runId、耗时、步骤状态、日志路径。

### 10.2 `acp_workflow`

参数：

1. `goal`：总体目标。
2. `workflow`：流程模板名，默认 `plan-merge-implement-validate`。
3. `planning_agents`：默认 `["codex", "claude"]`。
4. `implementation_agent`：默认 `gemini`。
5. `cwd`：工作目录。
6. `constraints`：技术栈、交付格式、禁止项。
7. `acceptance`：验收命令列表。

返回：

1. 工作流最终报告（成功/失败/部分成功）。
2. 工件目录与关键文件列表。
3. 风险列表和可执行下一步。

## 11. 执行与会话管理

### 11.1 会话命名规则

为保证跨重启可恢复且避免冲突，session 命名采用：

```text
neoclaw::<channel>::<chatIdHash>::<workflowId>::<stepId>::<agent>
```

规则：

1. 超长字段进行 hash 截断。
2. 同一 run 的同一步骤重试复用同名 session。
3. run 结束后按策略 `close` 或保留。

### 11.2 并发控制

1. 全局并发：`maxParallelRuns`。
2. 单会话串行：同一个 session 只允许一个 running step。
3. 并行规划：不同 session 可并行。

### 11.3 取消机制

1. 用户 `/stop` 或内部取消触发时，优先发 `acpx <agent> cancel -s <session>`。
2. 超时后先 cooperative cancel，等待窗口后再强制结束本地进程。

## 12. 错误处理与容错

### 12.1 错误分类

1. 配置错误：acpx 未安装、agent 不在 allow-list、cwd 越界。
2. 权限错误：permission denied、prompt unavailable。
3. 运行错误：adapter 启动失败、session 丢失、协议解析失败。
4. 业务错误：测试失败、构建失败、目标未达成。

### 12.2 重试策略

1. 仅对“可重试”错误重试，如会话加载失败、临时网络错误、队列断连。
2. 权限拒绝和输入校验错误不重试。
3. 重试采用指数退避：`retryBackoffMs * 2^attempt`，上限可配置。

### 12.3 降级策略

1. 当 ACP 执行层不可用且 `fallbackToCodeTool=true` 时，自动回退 `code` 工具。
2. 降级时必须在最终报告显式标记“已降级”。

## 13. 安全设计

### 13.1 命令执行安全

1. 仅使用参数数组调用进程，不使用 shell 拼接。
2. `cwd` 必须通过路径规范化并校验在允许根目录内。
3. 禁止用户直接覆盖 `command` 可执行路径，除非配置 allow-list。

### 13.2 敏感信息处理

1. 事件日志写盘前做敏感字段脱敏（token、secret、apiKey）。
2. Web API 返回日志摘要，不返回原始完整凭据。

### 13.3 权限最小化

1. 默认 `approve-reads`。
2. 高权限步骤（`approve-all`）需在工作流定义中显式声明。

## 14. 可观测性与审计

### 14.1 日志结构

输出目录：

```text
workspace/logs/acp/
  runs/<runId>/run.log
  runs/<runId>/steps/<stepId>.log
  runs/<runId>/steps/<stepId>.ndjson
```

### 14.2 指标

建议写入 `RuntimeStatusStore` 的新增指标：

1. `acp_runs_total`
2. `acp_runs_success_total`
3. `acp_runs_failed_total`
4. `acp_step_duration_ms`
5. `acp_retry_total`
6. `acp_fallback_total`

### 14.3 最终报告规范

最终报告固定包含：

1. 目标与结果。
2. 步骤执行摘要。
3. 关键工件路径。
4. 风险与未完成项。
5. 是否发生重试/降级。

## 15. Web 管理面扩展

在现有 Config 页面新增 ACP 配置区块：

1. 启用开关与默认 Agent。
2. 权限策略、超时、TTL、并发限制。
3. agent command override（高级）。
4. “ACP 健康检查”按钮（检查 acpx 与每个 agent 可用性）。

新增 API：

1. `GET /api/acp/health`
2. `GET /api/acp/runs?limit=...`
3. `GET /api/acp/runs/:id`
4. `POST /api/acp/runs/:id/cancel`

## 16. 与现有系统的集成点

### 16.1 `NeovateAgent`

在 `ensureSession().tool()` 注入：

1. `acp_run`
2. `acp_workflow`

同时保留现有 `code`、`spawn`、`memory` 工具。

### 16.2 配置与校验

需更新：

1. `src/config/schema.ts`：新增 `agent.acp` 结构与默认值。
2. `src/commands/web.ts`：配置读写与 `validateConfig` 扩展。
3. `webapp/src/pages/app/shared/ConfigWorkspace.tsx`：新增表单项。

### 16.3 目录初始化

`ensureWorkspaceDirs` 需创建：

1. `workspace/logs/acp`
2. `workspace/artifacts/acp-runs`

## 17. 测试策略

### 17.1 单元测试

1. 命令参数构建与权限参数映射。
2. NDJSON 事件解析与错误映射。
3. 状态机流转与重试行为。
4. cwd 安全校验与路径越界保护。

### 17.2 集成测试

1. 用 mock acpx 进程模拟 success/fail/timeout/cancel。
2. 覆盖并行规划与串行实施流程。
3. 覆盖 session ensure 与恢复逻辑。

### 17.3 端到端测试

1. 真机环境跑一次完整网站生成流程。
2. 注入失败场景（一个规划 agent 失败、测试失败再修复）。
3. 验证最终工件、日志、报告三者一致。

## 18. 发布与迁移策略

### 18.1 分阶段发布

1. `v1-beta`：隐藏开关，仅 CLI/内部启用。
2. `v1-ga`：开放 Web 配置和运行历史查看。
3. `v1.1`：支持自定义工作流模板与策略库。

### 18.2 配置兼容

1. 新增字段全部可选，缺省回落默认值。
2. 老配置无缝升级，不影响现有功能。

### 18.3 运行前置检查

启动时执行：

1. `acpx --version`
2. `acpx <agent> exec "ping"` 可选探测（可配置关闭）
3. 结果写入 runtime status，若失败给出明确可操作提示。

## 19. 验收标准

满足以下标准视为“完整且可稳定运行”：

1. 能按自然语言触发“codex+claude 规划，gemini 实施”的标准流程。
2. 规划步骤并行执行，实施步骤严格后置执行。
3. 故障可重试、可取消、可恢复，且日志可追溯。
4. 配置可在 Web 与文件两侧一致生效并通过校验。
5. ACP 不可用时可受控降级，不会中断主 agent 服务。

## 20. 风险与对策

1. `acpx` alpha 变更风险：锁定版本、启动自检、兼容层封装。
2. 多工具行为差异：统一错误模型与能力探测，不把差异暴露到业务层。
3. 长流程成本偏高：并行规划、超时限制、分步缓存与复用工件。
4. 权限过宽风险：默认最小权限、关键步骤显式升级。

## 21. 后续扩展

1. 工作流 DSL：支持声明式模板和条件分支。
2. 质量门禁插件：覆盖 lint/test/security 扫描统一 gate。
3. 变更评审模式：在实施前引入自动 diff review 步骤。
4. 多轮协同：支持“规划-实现-复审-二次实现”闭环。

