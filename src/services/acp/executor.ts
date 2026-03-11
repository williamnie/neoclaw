import { spawn, type ChildProcess } from "child_process";
import { resolve, join, dirname } from "path";
import { writeFileSync, mkdirSync } from "fs";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";

import { AcpError } from "./errors.js";
import { parseNdjsonStream } from "./parser.js";
import type { AcpRunRequest, AcpRunResult } from "./types.js";

interface ExecutorOptions {
    /** 调用的底层命令，默认应从配置中读取如 "acpx" */
    command: string;
    /** 当前 Neoclaw 服务的工作根区 */
    workspace: string;
    /** 允许执行的绝对目录底线，可与 workspace 一致 */
    allowedBaseDir: string;
}

/**
 * AcpExecutor (P0)
 * 负责安全调度底层系统进程 (acpx)。它仅承担单次节点进程拉起与回收，对工作流 DAG 和协调机制不敏感。
 */
export class AcpExecutor {
    // 保存运行期间的子进程实例以备后续 Cancellable 操作
    private activeProcesses = new Map<string, ChildProcess>();

    constructor(private opts: ExecutorOptions) { }

    /**
     * 启动一次 acpx 子进程并将其挂接到本地
     * 
     * @param request 标准单步请求定义
     * @param overrideLogPath (内部注入)强制指定该操作的日志输出目标（不抛给用户侧的配置）
     * @returns 聚合结束后的最终结果。
     */
    async execute(request: AcpRunRequest, providedRunId?: string, overrideLogPath?: string): Promise<AcpRunResult> {
        this.validateCwd(request.cwd);

        // 生成 runId，为了兼容编排引擎，支持传入特定 ID
        const runId = providedRunId ?? randomUUID().slice(0, 12);
        const args = this.buildArgs(request);

        const startTime = Date.now();
        const logPath = overrideLogPath ?? join(this.opts.workspace, "logs", "acp", `${runId}.log`);

        // 确保默认日志目录存在
        if (!overrideLogPath) {
            mkdirSync(join(this.opts.workspace, "logs", "acp"), { recursive: true });
        }

        let resultOutput = "";
        let rawStdout = "";   // 原始 stdout 回退：当 NDJSON 解析未捕获到 result 事件时使用
        let stderrOutput = "";
        let finalError: string | undefined;

        return new Promise<AcpRunResult>((resolvePromise, reject) => {
            let isSettled = false;
            const settle = (status: AcpRunResult["status"], manualError?: string) => {
                if (isSettled) return;
                isSettled = true;

                // 从 active 中移除
                this.activeProcesses.delete(runId);
                if (timer) clearTimeout(timer);

                // 优先使用 NDJSON 解析到的 result 输出，fallback 到原始 stdout
                const effectiveOutput = resultOutput || rawStdout;

                // 落地最终结果记录
                const outputReport = [
                    `--- Executor Session [${runId}] Ended ---`,
                    `Status: ${status}`,
                    `Duration: ${Date.now() - startTime}ms`,
                    manualError ? `Error: ${manualError}\n` : "",
                    stderrOutput.trim() ? `Stderr:\n${stderrOutput.trim()}\n` : "",
                    `Final Output Snippet:\n`,
                    effectiveOutput
                ].join("\n");

                // 简单写一次 Log （完整实现在 P1 环节应考虑流式写缓冲以提高性能）
                try { writeFileSync(logPath, outputReport, { flag: "a", encoding: "utf-8" }); } catch (e) { }

                // 如果指定了 outputPath，将完整输出写入结果工件文件
                let resolvedOutputPath: string | undefined;
                if (request.outputPath && effectiveOutput) {
                    try {
                        mkdirSync(dirname(request.outputPath), { recursive: true });
                        writeFileSync(request.outputPath, effectiveOutput, { encoding: "utf-8" });
                        resolvedOutputPath = request.outputPath;
                    } catch (e) { /* 写入失败不阻塞主流程 */ }
                }

                resolvePromise({
                    runId,
                    agent: request.agent,
                    status,
                    durationMs: Date.now() - startTime,
                    output: effectiveOutput || "No explicit output captured.",
                    logPath,
                    outputPath: resolvedOutputPath,
                    error: manualError
                });
            };

            try {
                const __dirname = dirname(fileURLToPath(import.meta.url));
                const localBinPath = join(__dirname, "..", "..", "..", "node_modules", ".bin");
                const env = { ...process.env };
                env.PATH = env.PATH ? `${localBinPath}:${env.PATH}` : localBinPath;

                const child = spawn(this.opts.command, args, {
                    cwd: request.cwd,
                    stdio: ["ignore", "pipe", "pipe"],
                    env,
                    // 绝对禁止 shell 拼接保护
                    shell: false
                });

                this.activeProcesses.set(runId, child);

                // 如果配置了超时，则建立隔离的倒地处理
                const timeoutPeriod = (request.timeoutSec ?? 300) * 1000;
                var timer: NodeJS.Timeout = setTimeout(() => {
                    this.cancelInternal(child);
                    finalError = `Execution timed out after ${request.timeoutSec}s.`;
                    settle("timed_out", finalError);
                }, timeoutPeriod);

                child.on("error", (err) => {
                    finalError = `Failed to spawn process: ${err.message}`;
                    settle("failed", finalError);
                });

                // NDJSON 事件流解析 — 保存 Promise 以便在 close 时等待其完成
                let streamParsingDone: Promise<void> = Promise.resolve();
                if (child.stdout) {
                    // 同时捕获原始 stdout 作为回退
                    child.stdout.on("data", (chunk: Buffer) => {
                        rawStdout += chunk.toString();
                    });

                    streamParsingDone = (async () => {
                        for await (const event of parseNdjsonStream(child.stdout!)) {
                            // 将主要事件写入缓冲或直接追加 Log 中
                            if (event.type === "result" && event.data?.text) {
                                resultOutput += event.data.text + "\n";
                            }
                            if (event.type === "error") {
                                finalError = (event.data?.message as string) || "Unknown error event received";
                            }
                        }
                    })();
                }

                // 捕获 stderr 输出，用于诊断进程启动失败等问题
                if (child.stderr) {
                    child.stderr.on("data", (chunk: Buffer) => {
                        stderrOutput += chunk.toString();
                    });
                }

                child.on("close", async (code, signal) => {
                    // 关键修复：等待 NDJSON 流解析完成后再 settle，避免竞态
                    try { await streamParsingDone; } catch { /* 解析失败不阻塞 settle */ }

                    if (signal === "SIGKILL" || signal === "SIGTERM") {
                        settle("cancelled");
                    } else if (code !== 0) {
                        const stderrHint = stderrOutput.trim()
                            ? `\nStderr: ${stderrOutput.trim().slice(0, 2000)}`
                            : "";
                        finalError = finalError || `Process exited with code ${code}${stderrHint}`;
                        settle("failed", finalError);
                    } else {
                        settle("succeeded");
                    }
                });

            } catch (err) {
                settle("failed", String(err));
            }
        });
    }

    /** 如果存在对应的运行中 session，强制其取消并回收资源 */
    async cancel(runId: string): Promise<void> {
        const child = this.activeProcesses.get(runId);
        if (child) {
            this.cancelInternal(child);
            this.activeProcesses.delete(runId);
        }
    }

    private cancelInternal(child: ChildProcess) {
        if (child.killed) return;

        // First try graceful term
        child.kill("SIGTERM");
        // Fall back to SIGKILL if still zombie
        setTimeout(() => {
            if (!child.killed) child.kill("SIGKILL");
        }, 5000).unref();
    }

    /**
     * 将参数化配置拼装成严格数组
     * 防止 shell injection
     */
    private buildArgs(request: AcpRunRequest): string[] {
        // 全局选项必须在 agent 子命令之前: acpx [global-opts] <agent> [subcmd] [prompt...]
        const args: string[] = [];

        // --format json 是顶级选项
        args.push("--format", "json");

        // permission 是顶级独立 flag（--approve-reads / --approve-all / --deny-all）
        if (request.permission) {
            args.push(`--${request.permission}`);
        }

        // agent 子命令
        args.push(request.agent);

        if (request.mode === "session") {
            // acpx ... codex -s <name> "prompt"
            if (request.sessionName) {
                args.push("-s", request.sessionName);
            }
        } else {
            // acpx ... codex exec "prompt"
            args.push("exec");
        }

        args.push("--", request.prompt);
        return args;
    }

    /**
     * 必须在被信任边界内调度。
     * 防止类似 cwd = "/" 生成全局覆写请求。
     */
    private validateCwd(cwd: string): void {
        const resolved = resolve(cwd);
        const baseDir = resolve(this.opts.allowedBaseDir);

        if (!resolved.startsWith(baseDir)) {
            throw new AcpError(
                "CWD_OUT_OF_BOUNDS",
                `Requested Working Directory <${cwd}> escapes the allowed base sandbox <${baseDir}>.`
            );
        }
    }
}
