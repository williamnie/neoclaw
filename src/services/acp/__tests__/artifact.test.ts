import { describe, expect, it, afterEach } from "bun:test";
import { existsSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { AcpArtifactManager } from "../artifact.js";
import type { StepManifest } from "../types.js";

const TEST_DIR = join("/tmp", "acp-artifact-test-" + Date.now());

afterEach(() => {
    if (existsSync(TEST_DIR)) {
        rmSync(TEST_DIR, { recursive: true, force: true });
    }
});

describe("AcpArtifactManager", () => {
    it("initializes base directory and subdirectories correctly", () => {
        const manager = new AcpArtifactManager(TEST_DIR);
        expect(existsSync(TEST_DIR)).toBe(true);

        const runDir = manager.getRunDir("run-123");
        expect(existsSync(runDir)).toBe(true);
        expect(runDir).toBe(join(TEST_DIR, "run-123"));

        const stepDir = manager.getStepDir("run-123", "step-abc");
        expect(existsSync(stepDir)).toBe(true);
        expect(stepDir).toBe(join(TEST_DIR, "run-123", "steps", "step-abc"));
    });

    it("writes and reads manifests properly", () => {
        const manager = new AcpArtifactManager(TEST_DIR);

        const manifest: StepManifest = {
            stepId: "plan_phase",
            agent: "codex",
            completedAt: new Date().toISOString(),
            coreOutputs: [{ path: "/foo/bar.md", description: "Design doc", kind: "plan" }],
            summary: "Planned stuff"
        };

        manager.writeManifest("run-1", manifest);
        const readBack = manager.readManifest("run-1", "plan_phase");

        expect(readBack).toBeDefined();
        expect(readBack?.stepId).toBe("plan_phase");
        expect(readBack?.coreOutputs[0].path).toBe("/foo/bar.md");

        // Test missing manifest
        const missing = manager.readManifest("run-1", "non-existent");
        expect(missing).toBeUndefined();
    });

    it("builds downstream prompt safely isolating context", () => {
        const manager = new AcpArtifactManager(TEST_DIR);

        // Create fake files for the context
        mkdirSync(join(TEST_DIR, "fake"), { recursive: true });
        const p1 = join(TEST_DIR, "fake", "out1.md");
        const p2 = join(TEST_DIR, "fake", "out2.md");
        writeFileSync(p1, "This is design text", "utf-8");
        writeFileSync(p2, "This is review text", "utf-8");

        const manifest1: StepManifest = {
            stepId: "step1",
            agent: "codex",
            completedAt: "",
            coreOutputs: [{ path: p1, description: "Design Output", kind: "plan" }]
        };
        const manifest2: StepManifest = {
            stepId: "step2",
            agent: "claude",
            completedAt: "",
            coreOutputs: [{ path: p2, description: "Review Output", kind: "spec" }]
        };

        const prompt = manager.buildDownstreamPrompt("Main Goal", [manifest1, manifest2]);

        expect(prompt).toContain("Main Goal");
        expect(prompt).toContain("## [Upstream: step1] Design Output");
        expect(prompt).toContain("This is design text");
        expect(prompt).toContain("## [Upstream: step2] Review Output");
        expect(prompt).toContain("This is review text");
    });

    it("handles missing files gracefully without crashing downstream injection", () => {
        const manager = new AcpArtifactManager(TEST_DIR);
        const manifest1: StepManifest = {
            stepId: "step1",
            agent: "codex",
            completedAt: "",
            coreOutputs: [{ path: "/does/not/exist.txt", description: "Missing File", kind: "plan" }]
        };

        const prompt = manager.buildDownstreamPrompt("Main Goal", [manifest1]);
        expect(prompt).toContain("Main Goal");
        expect(prompt).toContain("## [Upstream: step1] Missing File");
        expect(prompt).toContain("Error reading context file: ");
    });
});
