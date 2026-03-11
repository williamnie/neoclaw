import { createTool, _zod as z } from "@neovate/code";
import type { Config } from "../../config/schema.js";
import type { WorkflowOrchestrator } from "../../services/acp/orchestrator.js";

interface AcpWorkflowOpts {
    config: Config;
    orchestrator: WorkflowOrchestrator;
    channel: string;
    chatId: string;
}

export function createAcpWorkflowTool(opts: AcpWorkflowOpts): ReturnType<typeof createTool> {
    const { config, orchestrator, channel, chatId } = opts;

    return createTool({
        name: "acp_workflow",
        description:
            "Submit a complex coding task to the asynchronous ACP (Agent Coding Pipeline) multi-agent orchestrator. " +
            "This tool initiates a Proposer-Critic workflow. It returns immediately with a Job ID. " +
            "You will receive background progress updates in subsequent messages as the workflow advances.",
        parameters: z.object({
            task: z.string().describe("The complex coding task goal to accomplish"),
            cwd: z.string().describe("Absolute path to the working directory"),
            plan_agent: z
                .enum(["codex", "claude", "gemini"])
                .optional()
                .describe("Agent strictly to generate the design document. Defaults to codex"),
            review_agent: z
                .enum(["codex", "claude", "gemini"])
                .optional()
                .describe("Agent strictly to review the design document. Defaults to claude"),
            implement_agent: z
                .enum(["codex", "claude", "gemini"])
                .optional()
                .describe("Agent strictly to implement the reviewed design. Defaults to gemini"),
        }),
        async execute(params) {
            if (!config.acp?.enabled) {
                return { llmContent: "Error: ACP system is not enabled in configuration.", isError: true };
            }

            try {
                const runId = await orchestrator.submit(
                    {
                        goal: params.task,
                        cwd: params.cwd,
                        planAgent: params.plan_agent,
                        reviewAgent: params.review_agent,
                        implementAgent: params.implement_agent,
                    },
                    channel,
                    chatId
                );

                return {
                    llmContent: `Workflow submitted successfully. Run ID: ${runId}\nTracking and updates will be posted to this chat asynchronously. Do not wait for it now.`,
                    isError: false,
                };
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return { llmContent: `Error submitting acp_workflow task: ${msg}`, isError: true };
            }
        },
    });
}
