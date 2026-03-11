/**
 * DAG 节点标准模版类型及对上游产物约定的默认内建。
 * 用于定义串行 Proposer-Critic 流向。
 */
export interface WorkflowStepDef {
    id: string;
    agent: string;
    dependsOn: string[];
    permission: "approve-reads" | "approve-all" | "deny-all";
    timeoutSec: number;
    maxRetries: number;
    promptTemplate: string;
    outputKinds: string[];
}

export interface WorkflowTemplate {
    id: string;
    description: string;
    steps: WorkflowStepDef[];
}

/** 基于 Gemini 的 4 层架构审查而修正的主干默认工作流。 */
export const DEFAULT_WORKFLOW: WorkflowTemplate = {
    id: "proposer-critic-implement-validate",
    description: "Proposer-Critic 串行对抗 + 实施 + 验证",
    steps: [
        {
            id: "plan_propose",
            agent: "codex",
            dependsOn: [],
            permission: "approve-reads",
            timeoutSec: 300,
            maxRetries: 1,
            promptTemplate: "请为以下需求生成完整的技术架构设计和目录骨架。要求：输出 markdown 格式的设计文档。",
            outputKinds: ["plan"],
        },
        {
            id: "plan_review",
            agent: "claude",
            dependsOn: ["plan_propose"],
            permission: "approve-reads",
            timeoutSec: 300,
            maxRetries: 1,
            promptTemplate: "请审查刚才生成的技术方案（位于“上游交接上下文”），指出安全性、边界异常与架构合理性问题，并直接输出修订后的最终方案。",
            outputKinds: ["spec"],
        },
        {
            id: "implement",
            agent: "gemini",
            dependsOn: ["plan_review"],
            permission: "approve-all", // 代码真正实施必须可操作
            timeoutSec: 600,
            maxRetries: 2,
            promptTemplate: "请严格按照上述审查过的“上游交接上下文”中最新的技术规范实现代码，不要偏离设计。如果遇到任何缺漏请自行推断合适的通用实践。",
            outputKinds: ["code"],
        },
        {
            id: "validate",
            agent: "$local", // 本地验证器暂用内部延迟 mock
            dependsOn: ["implement"],
            permission: "deny-all",
            timeoutSec: 120,
            maxRetries: 0,
            promptTemplate: "Review and syntax check logic...",
            outputKinds: ["validation-report"],
        },
    ],
};
