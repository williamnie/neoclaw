import { describe, expect, it, mock, afterEach } from "bun:test";
import { WorkflowOrchestrator } from "../orchestrator.js";
import type { AcpExecutor } from "../executor.js";
import type { AcpSessionRouter } from "../session-router.js";
import type { MessageBus, InboundMessage } from "../../../bus/types.js";
import type { AcpConfig } from "../../../config/schema.js";
import { join } from "path";
import { existsSync, rmSync } from "fs";

const TEST_DIR = join("/tmp", "acp-orch-test-" + Date.now());

const dummyConfig: AcpConfig = {
    enabled: true,
    command: "acpx",
    defaultAgent: "codex",
    allowedAgents: ["codex", "claude", "gemini"],
    defaultPermission: "approve-reads",
    timeoutSec: 30,
    maxParallelRuns: 1,
    maxStepRetries: 1,
    retryBackoffMs: 1,
    autoEnsureSession: false,
    fallbackToCodeTool: false,
    artifactDir: TEST_DIR,
    logDir: TEST_DIR,
    stateDir: TEST_DIR,
};

// @ts-ignore
const mockBus: MessageBus = {
    publishInbound: mock((msg: InboundMessage) => { }),
    publishOutbound: mock(() => { }),
    subscribeInbound: mock(() => () => { }),
    subscribeOutbound: mock(() => () => { }),
    on: mock(() => { }),
    off: mock(() => { }),
    emit: mock(() => true)
};

const mockExecutor = {
    execute: mock(async () => ({ status: "succeeded", output: "ok", durationMs: 10, logPath: "/tmp/log" })),
    cancel: mock(async () => { })
} as unknown as AcpExecutor;

const mockRouter = {
    buildSessionName: mock(() => "sess-1"),
    ensureSession: mock(async () => { }),
    closeSession: mock(async () => { })
} as unknown as AcpSessionRouter;

describe("WorkflowOrchestrator", () => {
    afterEach(() => {
        if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
        (mockExecutor.execute as any).mockClear();
        (mockBus.publishInbound as any).mockClear();
    });

    it("submits and completely advances a workflow successfully", async () => {
        const orch = new WorkflowOrchestrator(mockExecutor, mockRouter, mockBus, dummyConfig);

        // 我们只需检查 submit 能返回 ID，且能够不阻塞主线程地往下流转
        const runId = await orch.submit({
            goal: "Test goal",
            cwd: "/tmp",
            planAgent: "codex",
            reviewAgent: "claude",
            implementAgent: "gemini"
        }, "telegram", "chat-1");

        expect(runId).toBeDefined();
        expect(runId.length).toBeGreaterThan(0);

        // 给事件循环一点时间让 Promise 链推进
        // 由于内部 local / execute 耗时极短且重试延迟只有 1ms，我们可以等待极短时间
        await new Promise(r => setTimeout(r, 1500));

        // 应发布多次 InboundMessage，含有进度或结束通知
        expect(mockBus.publishInbound).toHaveBeenCalled();
        const calls: any[] = (mockBus.publishInbound as any).mock.calls;

        const messages = calls.map(c => c[0].content);
        const hasCompletion = messages.some(m => m.includes("FINISHED") && m.includes("succeeded"));
        expect(hasCompletion).toBe(true);
    });

    it("suspends workflow when an agent fails constantly", async () => {
        const failingExecutor = {
            execute: mock(async () => ({ status: "failed", error: "Agent blew up" })),
            cancel: mock(async () => { })
        } as unknown as AcpExecutor;

        const orch = new WorkflowOrchestrator(failingExecutor, mockRouter, mockBus, dummyConfig);
        const runId = await orch.submit({ goal: "Fail test", cwd: "/tmp" }, "cli", "chat-2");

        await new Promise(r => setTimeout(r, 1500));

        const calls: any[] = (mockBus.publishInbound as any).mock.calls;
        const messages = calls.map(c => c[0].content);

        // 由于是 Agent 错误引发 failed，系统会尝试 retry，两次都挂后进入 suspended_waiting_for_user
        const hasSuspend = messages.some(m => m.includes("SUSPENDED") && m.includes("Agent blew up"));
        expect(hasSuspend).toBe(true);

        const record = await orch["loadRunRecord"](runId);
        expect(record?.status).toBe("suspended_waiting_for_user");
    });

    it("can resume a suspended workflow", async () => {
        // 这里我们造一个内部记录强行注入磁盘，再通过 resume 唤醒
        const orch = new WorkflowOrchestrator(mockExecutor, mockRouter, mockBus, dummyConfig);
        const runId = "test-resume-1";
        await orch["persistRunRecord"]({
            runId,
            channel: "cli",
            chatId: "1",
            goal: "resume-test",
            templateId: "proposer-critic-implement-validate",
            status: "suspended_waiting_for_user",
            steps: [
                { id: "plan_propose", agent: "codex", status: "suspended", attempts: 2 }
            ],
            artifacts: [],
            requestedAt: new Date().toISOString()
        });

        const res = await orch.resume("test-resume-1");
        expect(res).toBe(true);

        await new Promise(r => setTimeout(r, 1500));

        const record = await orch["loadRunRecord"]("test-resume-1");
        // Resume 之后，正常的 execute mock 会让其跑到成功
        expect(record?.status).toBe("succeeded");
    });

    it("cancels a running workflow", async () => {
        const slowExecutor = {
            execute: mock(async () => {
                await new Promise(r => setTimeout(r, 20000));
                return { status: "succeeded" };
            }),
            cancel: mock(async () => { })
        } as unknown as AcpExecutor;

        const orch = new WorkflowOrchestrator(slowExecutor, mockRouter, mockBus, dummyConfig);
        const runId = await orch.submit({ goal: "cancel me", cwd: "/tmp" }, "cli", "1");

        // 给系统一点时间把 step1 塞入
        await new Promise(r => setTimeout(r, 50));

        const cancelled = await orch.cancel(runId);
        expect(cancelled).toBe(true);

        const record = await orch["loadRunRecord"](runId);
        expect(record?.status).toBe("cancelled");
        expect(slowExecutor.cancel).toHaveBeenCalled();
    });
});
