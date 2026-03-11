import { createTool, _zod as z } from "@neovate/code";
import type { Config } from "../../config/schema.js";
import type { AcpExecutor } from "../../services/acp/executor.js";

interface AcpRunOpts {
    config: Config;
    executor: AcpExecutor;
}

export function createAcpRunTool(opts: AcpRunOpts): ReturnType<typeof createTool> {
    const { config, executor } = opts;

    return createTool({
        name: "acp_run",
        description:
            "Execute a coding task using a specific AI coding agent (codex/claude/gemini). " +
            "Spawns the agent via acpx, waits for completion, and returns the result. " +
            "For complex multi-step workflows, use acp_workflow instead.",
        parameters: z.object({
            task: z.string().describe("The coding task prompt to execute"),
            agent: z
                .enum(["codex", "claude", "gemini"])
                .describe("Which AI coding agent to use (codex, claude, gemini)"),
            cwd: z.string().describe("Absolute path to the working directory"),
            permission: z
                .enum(["approve-reads", "approve-all", "deny-all"])
                .optional()
                .describe("Permission level. Defaults to approve-reads"),
            timeout_sec: z
                .number()
                .optional()
                .describe("Timeout in seconds. Defaults to config value"),
            output_path: z
                .string()
                .optional()
                .describe("Optional path to write the result artifact"),
        }),
        async execute(params) {
            const acpConfig = config.acp;
            if (!acpConfig || !acpConfig.enabled) {
                return { llmContent: "Error: ACP system is not enabled in configuration.", isError: true };
            }

            if (!acpConfig.allowedAgents.includes(params.agent)) {
                return {
                    llmContent: `Error: agent "${params.agent}" is not in the allowed list: [${acpConfig.allowedAgents.join(", ")}]`,
                    isError: true,
                };
            }

            try {
                const result = await executor.execute({
                    agent: params.agent,
                    prompt: params.task,
                    cwd: params.cwd,
                    mode: "exec",
                    permission: params.permission ?? acpConfig.defaultPermission,
                    timeoutSec: params.timeout_sec ?? acpConfig.timeoutSec,
                    outputPath: params.output_path,
                });

                const reportLines = [
                    `Agent: ${result.agent}`,
                    `Status: ${result.status}`,
                    `Duration: ${result.durationMs}ms`,
                    `Log: ${result.logPath}`,
                ];

                if (result.outputPath) {
                    reportLines.push(`Result file: ${result.outputPath}`);
                }

                reportLines.push(
                    ``,
                    `Full output is saved to the log/result file. Tell the user the file path so they can check the details directly.`,
                );

                return {
                    llmContent: reportLines.join("\n"),
                    isError: result.status !== "succeeded",
                };
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return { llmContent: `Error executing acp_run tool: ${msg}`, isError: true };
            }
        },
    });
}
