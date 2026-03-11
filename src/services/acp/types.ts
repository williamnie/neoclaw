/** 
 * 单步执行请求配置，对应 acp_run 工具参数 
 */
export interface AcpRunRequest {
    agent: "codex" | "claude" | "gemini" | string;
    prompt: string;
    cwd: string;
    mode: "exec" | "session";
    sessionName?: string;
    timeoutSec?: number;
    permission?: "approve-all" | "approve-reads" | "deny-all";
    outputPath?: string; // 指定结果工件的可选写入路径
}

/** 
 * 单次 acpx 调用的最终结果结构
 */
export interface AcpRunResult {
    runId: string;
    agent: string;
    status: "succeeded" | "failed" | "timed_out" | "cancelled";
    durationMs: number;
    output: string;      // 最终聚合的文本结果
    logPath: string;     // 本次执行追踪日志文件的路径
    outputPath?: string; // 结果工件文件路径（如果指定了 outputPath）
    error?: string;
}

/** 
 * acpx 子进程 --format json 标准输出推送的事件抽象
 */
export interface AcpEvent {
    type: "start" | "progress" | "tool_use" | "result" | "error" | "done";
    timestamp: string;
    data: Record<string, unknown>;
}

// ============== 下方编排层类型（P1 阶段实施基础）==============

/** 工作流步骤记录 */
export interface WorkflowStepRecord {
    id: string;
    agent: string;
    status: StepStatus;
    attempts: number;
    startedAt?: string;
    finishedAt?: string;
    error?: string;
    manifestPath?: string;
}

export type StepStatus =
    | "pending"
    | "running"
    | "succeeded"
    | "failed"
    | "retrying"
    | "cancelled"
    | "timed_out"
    | "skipped"
    | "suspended";

export type WorkflowStatus =
    | "pending"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "suspended_waiting_for_user";

/** 工作流宏观运行记录 */
export interface WorkflowRunRecord {
    runId: string;
    channel: string;
    chatId: string;
    goal: string;
    templateId: string;
    requestedAt: string;
    startedAt?: string;
    finishedAt?: string;
    status: WorkflowStatus;
    steps: WorkflowStepRecord[];
    artifacts: WorkflowArtifact[];
}

export interface WorkflowArtifact {
    id: string;
    stepId: string;
    kind: "plan" | "spec" | "code" | "review" | "validation-report" | "log" | "raw-events";
    path: string; // 相对于 artifactDir
    createdAt: string;
    summary?: string;
}

/** 工件交接契约声明表 */
export interface StepManifest {
    stepId: string;
    agent: string;
    completedAt: string;
    /** 交接给下游的核心上下文清单 */
    coreOutputs: Array<{
        path: string;
        kind: "plan" | "spec" | "code" | "review";
        description: string;
    }>;
    /** 仅供审计查看的丢弃类日志追踪文件 */
    traceOutputs: Array<{
        path: string;
        kind: "log" | "raw-events" | "debug";
    }>;
    summary: string;
}
