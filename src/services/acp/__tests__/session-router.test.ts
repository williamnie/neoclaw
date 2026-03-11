import { describe, expect, it, mock } from "bun:test";
import { AcpSessionRouter } from "../session-router.js";
import type { AcpExecutor } from "../executor.js";
import type { AcpConfig } from "../../../config/schema.js";

const dummyConfig: AcpConfig = {
    enabled: true,
    command: "acpx",
    defaultAgent: "codex",
    allowedAgents: ["codex"],
    defaultPermission: "approve-reads",
    timeoutSec: 30,
    maxParallelRuns: 1,
    maxStepRetries: 1,
    retryBackoffMs: 10,
    autoEnsureSession: true,
    fallbackToCodeTool: false,
    artifactDir: "/tmp",
    logDir: "/tmp",
    stateDir: "/tmp",
};

describe("AcpSessionRouter", () => {
    it("builds consistent session names", () => {
        const executor = {} as AcpExecutor;
        const router = new AcpSessionRouter(dummyConfig, executor);

        const s1 = router.buildSessionName("telegram", "chat123", "run-1", "step-A", "gemini");
        const s2 = router.buildSessionName("telegram", "chat123", "run-1", "step-A", "gemini");
        const s3 = router.buildSessionName("telegram", "chat999", "run-1", "step-A", "gemini");

        expect(s1).toBe(s2);
        expect(s1).not.toBe(s3);
        expect(s1).toContain("neoclaw::telegram::");
        expect(s1).toContain("::run-1::step-A::gemini");
    });

    it("ensures session using executor when autoEnsureSession is true", async () => {
        const mockExecute = mock(async () => ({ status: "succeeded", output: "ok" }));
        const executor = { execute: mockExecute } as unknown as AcpExecutor;
        const router = new AcpSessionRouter(dummyConfig, executor);

        await router.ensureSession("safe-sess", "codex", "/tmp");
        expect(mockExecute).toHaveBeenCalled();
        const callArgs = mockExecute.mock.calls[0][0];
        expect(callArgs.prompt).toBe("sessions ensure -s safe-sess");
        expect(callArgs.agent).toBe("codex");
        expect(callArgs.mode).toBe("exec");
    });

    it("skips ensure if autoEnsureSession is false", async () => {
        const mockExecute = mock(async () => ({ status: "succeeded" }));
        const executor = { execute: mockExecute } as unknown as AcpExecutor;
        const router = new AcpSessionRouter({ ...dummyConfig, autoEnsureSession: false }, executor);

        await router.ensureSession("safe-sess", "codex", "/tmp");
        expect(mockExecute).not.toHaveBeenCalled();
    });

    it("closes session safely using exec mode", async () => {
        const mockExecute = mock(async () => ({ status: "succeeded" }));
        const executor = { execute: mockExecute } as unknown as AcpExecutor;
        const router = new AcpSessionRouter(dummyConfig, executor);

        await router.closeSession("safe-sess", "codex", "/tmp");
        expect(mockExecute).toHaveBeenCalled();
        const callArgs = mockExecute.mock.calls[0][0];
        expect(callArgs.prompt).toBe("sessions close -s safe-sess");
    });
});
