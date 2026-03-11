import { describe, expect, it } from "bun:test";
import { AcpExecutor } from "../executor.js";
import { AcpError } from "../errors.js";
import { join } from "path";

describe("AcpExecutor ValidateCwd", () => {
    it("allows paths inside allowed base dir", () => {
        const executor = new AcpExecutor({
            command: "acpx",
            workspace: "/home/user/proj",
            allowedBaseDir: "/home/user"
        });

        const validPath = join("/home/user/proj", "src");
        // Should not throw
        expect(() => executor["validateCwd"](validPath)).not.toThrow();
    });

    it("blocks paths outside allowed base dir via path traversal", () => {
        const executor = new AcpExecutor({
            command: "acpx",
            workspace: "/home/user/proj",
            allowedBaseDir: "/home/user/proj"
        });

        const sneakyPath = join("/home/user/proj", "..", "secrets");
        expect(() => executor["validateCwd"](sneakyPath)).toThrow(AcpError);
        expect(() => executor["validateCwd"](sneakyPath)).toThrow(/escapes the allowed base sandbox/);
    });

    it("blocks completely external roots", () => {
        const executor = new AcpExecutor({
            command: "acpx",
            workspace: "/home/user/proj",
            allowedBaseDir: "/home/user/proj"
        });

        expect(() => executor["validateCwd"]("/etc/passwd")).toThrow(AcpError);
    });
});

describe("AcpExecutor arguments sanitization", () => {
    it("assembles basic run arguments correctly", () => {
        const executor = new AcpExecutor({
            command: "acpx",
            workspace: "/tmp",
            allowedBaseDir: "/tmp"
        });

        const args = executor["buildArgs"]({
            agent: "codex",
            mode: "exec",
            prompt: "echo hello",
            cwd: "/tmp",
            permission: "approve-reads"
        });

        expect(args).toEqual([
            "codex",
            "exec",
            "--format",
            "json",
            "--permission",
            "approve-reads",
            "--",
            "echo hello"
        ]);
    });

    it("assembles session arguments correctly with sessionName and fallback code tool", () => {
        const executor = new AcpExecutor({
            command: "acpx",
            workspace: "/tmp",
            allowedBaseDir: "/tmp"
        });

        const args = executor["buildArgs"]({
            agent: "claude",
            mode: "session",
            sessionName: "sess-123",
            prompt: "do stuff",
            cwd: "/tmp",
            permission: "approve-all",
            fallbackToCodeTool: true
        } as any);

        expect(args).toEqual([
            "claude",
            "session",
            "send",
            "-s",
            "sess-123",
            "--format",
            "json",
            "--permission",
            "approve-all",
            "--",
            "do stuff"
        ]);
    });
});
