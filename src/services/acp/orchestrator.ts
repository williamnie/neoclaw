import { join } from "path";
import { mkdirSync, writeFileSync, readFileSync } from "fs";
import { randomUUID } from "crypto";

import type { AcpExecutor } from "./executor.js";
import type { AcpSessionRouter } from "./session-router.js";
import { AcpArtifactManager } from "./artifact.js";
import type { AcpConfig } from "../../config/schema.js";
import type { MessageBus } from "../../bus/message-bus.js";
import type { RuntimeStatusStore } from "../../runtime/status-store.js";
import { AcpError, isRetryableError } from "./errors.js";
import type {
    WorkflowRunRecord,
    WorkflowStepRecord,
    StepManifest,
    WorkflowStatus
} from "./types.js";
import { DEFAULT_WORKFLOW, type WorkflowStepDef } from "./workflow-spec.js";
import { logger } from "../../logger.js";

/** 提交工作流的输入定义 */
export interface AcpWorkflowRequest {
    goal: string;
    workflowTemplate?: string;
    planAgent?: string;
    reviewAgent?: string;
    implementAgent?: string;
    cwd: string;
    constraints?: string;
    acceptance?: string[];
}

export class WorkflowOrchestrator {
    private artifactManager: AcpArtifactManager;

    constructor(
        private executor: AcpExecutor,
        private sessionRouter: AcpSessionRouter,
        private bus: MessageBus,
        private config: AcpConfig,
        private statusStore?: RuntimeStatusStore,
    ) {
        this.artifactManager = new AcpArtifactManager(this.config.artifactDir);
    }

    /**
     * 提交工作流执行，立即返回生成的 jobId，通过后台异步推进状态机。
     */
    async submit(
        request: AcpWorkflowRequest,
        originChannel: string,
        originChatId: string,
    ): Promise<string> {
        const runId = randomUUID().slice(0, 12);

        const record: WorkflowRunRecord = {
            runId,
            channel: originChannel,
            chatId: originChatId,
            goal: request.goal,
            templateId: request.workflowTemplate ?? DEFAULT_WORKFLOW.id,
            requestedAt: new Date().toISOString(),
            status: "pending",
            steps: [],
            artifacts: [],
        };

        await this.persistRunRecord(record);

        // 启动非阻塞执行网环
        // promise.catch 防止未捕获的一场中断主进程
        this.runWorkflowDag(record, request).catch((err) => {
            logger.error("acp", `Fatal DAG Error for run ${runId}:`, err);
            record.status = "failed";
            this.persistRunRecord(record).catch(() => { });
        });

        return runId;
    }

    private async runWorkflowDag(record: WorkflowRunRecord, request: AcpWorkflowRequest): Promise<void> {
        record.status = "running";
        record.startedAt = new Date().toISOString();
        await this.persistRunRecord(record);

        const template = DEFAULT_WORKFLOW;

        for (const stepDef of template.steps) {
            // 若出现外部中断或人为要求挂起，则立即跳出推进流
            if ((record.status as string) === "cancelled" || (record.status as string) === "suspended_waiting_for_user") {
                break;
            }

            // 验证依赖
            const depsOk = stepDef.dependsOn.every((depId: string) => {
                const dep = record.steps.find((s) => s.id === depId);
                return dep?.status === "succeeded";
            });
            if (!depsOk) {
                // 如果有任何一个依赖没有成功，当前步骤被跳过
                const skipRec: WorkflowStepRecord = {
                    id: stepDef.id,
                    agent: stepDef.agent,
                    status: "skipped",
                    attempts: 0
                };
                record.steps.push(skipRec);
                continue;
            }

            await this.executeStepWithRetry(record, stepDef, request);
        }

        // 更新终态判定
        if (record.status === "running") {
            const allSucceeded = record.steps.every(s =>
                s.status === "succeeded" || s.status === "skipped" // Skipped doesn't cause fail
            );
            // 如果最后一个核心的非 skipped 节点挂了，或者某节点 failed 而中断的话
            const hasFailed = record.steps.some((s) => s.status === "failed");
            record.status = hasFailed ? "failed" : "succeeded";
        }

        record.finishedAt = new Date().toISOString();
        await this.persistRunRecord(record);
        this.notifyCompletion(record);
    }

    private resolveDynamicAgent(stepDef: WorkflowStepDef, request: AcpWorkflowRequest): string {
        if (stepDef.agent === "$local") return "$local";
        if (stepDef.id === "plan_propose" && request.planAgent) return request.planAgent;
        if (stepDef.id === "plan_review" && request.reviewAgent) return request.reviewAgent;
        if (stepDef.id === "implement" && request.implementAgent) return request.implementAgent;
        return stepDef.agent;
    }

    private async executeStepWithRetry(
        record: WorkflowRunRecord,
        stepDef: WorkflowStepDef,
        request: AcpWorkflowRequest
    ): Promise<void> {

        const resolvedAgent = this.resolveDynamicAgent(stepDef, request);
        const stepRecord: WorkflowStepRecord = {
            id: stepDef.id,
            agent: resolvedAgent,
            status: "pending",
            attempts: 0,
        };
        record.steps.push(stepRecord);

        const maxRetries = stepDef.maxRetries ?? this.config.maxStepRetries;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            if (record.status === "cancelled") return;

            stepRecord.attempts = attempt + 1;
            stepRecord.status = attempt === 0 ? "running" : "retrying";
            stepRecord.startedAt = new Date().toISOString();
            await this.persistRunRecord(record);

            try {
                if (resolvedAgent === "$local") {
                    // 在 P1 中，为验证留出的桩
                    await new Promise(r => setTimeout(r, 1000));
                } else {
                    await this.executeAgentViaExecutor(record, stepRecord, stepDef, request);
                }

                stepRecord.status = "succeeded";
                stepRecord.finishedAt = new Date().toISOString();
                this.notifyStepComplete(record, stepRecord);
                return;

            } catch (err) {
                const acpErr = err instanceof AcpError ? err : new AcpError("AGENT_ERROR", String(err));
                stepRecord.error = acpErr.message;
                logger.warn("acp", `Step ${stepRecord.id} attempt ${attempt + 1} failed: ${acpErr}`);

                // 在无法重试、或重试次数达顶时执行 断点挂起 Suspend 
                if (!isRetryableError(acpErr.code) || attempt >= maxRetries) {
                    stepRecord.status = "suspended";
                    record.status = "suspended_waiting_for_user";
                    await this.persistRunRecord(record);

                    this.notifySuspend(record, stepRecord, acpErr);
                    return;
                }

                // 指数退避，防止频繁空转刷爆
                const backoff = Math.min(this.config.retryBackoffMs * Math.pow(2, attempt), 30000);
                await new Promise(r => setTimeout(r, backoff));
            }
        }
    }

    private async executeAgentViaExecutor(
        record: WorkflowRunRecord,
        stepRecord: WorkflowStepRecord,
        stepDef: WorkflowStepDef,
        request: AcpWorkflowRequest
    ): Promise<void> {
        // 聚合上游的 Manifests 以生成下游只读阻断型的上下文 (幻觉防御机制)
        const upstreamIds = stepDef.dependsOn;
        const manifests = upstreamIds
            .map((id: string) => this.artifactManager.readManifest(record.runId, id))
            .filter((m: StepManifest | undefined): m is StepManifest => m !== undefined);

        const safePrompt = this.artifactManager.buildDownstreamPrompt(request.goal, manifests);
        const sessionName = this.sessionRouter.buildSessionName(
            record.channel, record.chatId, record.runId, stepDef.id, stepRecord.agent
        );

        // 自动通过 Session Router 来保证后台有这个名字开启着
        await this.sessionRouter.ensureSession(sessionName, stepRecord.agent, request.cwd);

        // 发起调用，并在其产出结果路径固定在 Artifact 区
        const artifactPath = join(this.artifactManager.getStepDir(record.runId, stepDef.id), "cli_output.md");

        const execRes = await this.executor.execute({
            agent: stepRecord.agent,
            cwd: request.cwd,
            prompt: `${stepDef.promptTemplate}\n\n${safePrompt}`,
            mode: "session",
            sessionName: sessionName,
            permission: stepDef.permission,
            timeoutSec: stepDef.timeoutSec
        }, record.runId, artifactPath);

        if (execRes.status !== "succeeded") {
            throw new AcpError(
                execRes.status === "timed_out" ? "TIMEOUT" : "AGENT_ERROR",
                `Agent execution ended with status ${execRes.status}: ${execRes.error ?? ''}`,
                execRes.status === "timed_out" || execRes.status === "failed"
            );
        }

        // 模拟写入工件 Manifest 来向更下游汇报契约
        const manifest: StepManifest = {
            stepId: stepDef.id,
            agent: stepRecord.agent,
            completedAt: new Date().toISOString(),
            coreOutputs: [
                { path: artifactPath, kind: stepDef.outputKinds[0] as any || "code", description: `${stepDef.id} output` }
            ],
            traceOutputs: [
                { path: execRes.logPath, kind: "log" }
            ],
            summary: `Completed ${stepDef.id} taking ${execRes.durationMs}ms.`
        };

        stepRecord.manifestPath = this.artifactManager.writeManifest(record.runId, manifest);
    }

    // ============== 对外服务 ==============

    async resume(runId: string): Promise<boolean> {
        const record = await this.loadRunRecord(runId);
        if (!record || record.status !== "suspended_waiting_for_user") return false;

        // 清零当前卡点的尝试次数，从新起跑
        const suspendedStep = record.steps.find((s) => s.status === "suspended");
        if (suspendedStep) {
            suspendedStep.status = "pending";
            suspendedStep.error = undefined;
            suspendedStep.attempts = 0;
        }

        // 我们还需要重新启动没有传递过去的参数，这里简单回放即可
        // P1 阶段简化，从头开始不执行已经成功过的（通过 depsOk 过滤）
        const dummyReq: AcpWorkflowRequest = { goal: record.goal, cwd: this.config.stateDir };
        this.runWorkflowDag(record, dummyReq).catch(() => { });
        return true;
    }

    async cancel(runId: string): Promise<boolean> {
        const record = await this.loadRunRecord(runId);
        if (!record || record.status === "succeeded" || record.status === "failed") return false;

        record.status = "cancelled";
        record.finishedAt = new Date().toISOString();
        await this.persistRunRecord(record);

        // 强行终止背后的所有物理资源
        await this.executor.cancel(runId);

        return true;
    }

    // ============== 内部工具与事件派发 ==============

    private async persistRunRecord(record: WorkflowRunRecord): Promise<void> {
        const dir = this.artifactManager.getRunDir(record.runId);
        writeFileSync(join(dir, "run.json"), JSON.stringify(record, null, 2), "utf-8");
    }

    private async loadRunRecord(runId: string): Promise<WorkflowRunRecord | undefined> {
        try {
            const dir = this.artifactManager.getRunDir(runId);
            const str = readFileSync(join(dir, "run.json"), "utf-8");
            return JSON.parse(str) as WorkflowRunRecord;
        } catch {
            return undefined;
        }
    }

    private notifyStepComplete(record: WorkflowRunRecord, stepRecord: WorkflowStepRecord): void {
        const msg = `[ACP Workflow ${record.runId} step "${stepRecord.id}" completed]\nAgent: ${stepRecord.agent}\nRef: ${stepRecord.manifestPath || "none"}`;
        this.sendSysInboundMessage(record, msg, { acpStepId: stepRecord.id });
    }

    private notifySuspend(record: WorkflowRunRecord, stepRecord: WorkflowStepRecord, error: AcpError): void {
        const msg = `[ACP Workflow ${record.runId} SUSPENDED]\nStep: ${stepRecord.id}\nError: ${error.message}\nAction Required: Fix the problem and execute "/acp resume ${record.runId}" to continue.`;
        this.sendSysInboundMessage(record, msg, { acpStepId: stepRecord.id, suspended: true });
    }

    private notifyCompletion(record: WorkflowRunRecord): void {
        const msg = `[ACP Workflow ${record.runId} FINISHED]\nFinal Status: ${record.status}\nGoal: ${record.goal}\nArtifacts: stored at ${this.config.artifactDir}/${record.runId}\nPlease summarize this result for the user.`;
        this.sendSysInboundMessage(record, msg, {});
    }

    private sendSysInboundMessage(record: WorkflowRunRecord, text: string, extraMeta: any): void {
        this.bus.publishInbound({
            channel: "system",
            senderId: `acp:${record.runId}`,
            chatId: `${record.channel}:${record.chatId}`, // 为 Agent 唤醒提供 reply 路由溯源点
            content: text,
            timestamp: new Date(),
            media: [],
            metadata: {
                acpRunId: record.runId,
                originChannel: record.channel,
                originChatId: record.chatId,
                ...extraMeta
            }
        });
    }
}
