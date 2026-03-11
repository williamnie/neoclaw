import { createHash } from "crypto";
import type { AcpExecutor } from "./executor.js";
import type { AcpConfig } from "../../config/schema.js";
import { logger } from "../../logger.js";

export class AcpSessionRouter {
    constructor(
        private config: AcpConfig,
        private executor: AcpExecutor,
    ) { }

    /**
     * 生成统一格式且具备身份溯源与重启恢复能力的的 Session 名称。
     * 格式: neoclaw::<channel>::<chatIdHash8>::<runId>::<stepId>::<agent>
     */
    buildSessionName(
        channel: string,
        chatId: string,
        runId: string,
        stepId: string,
        agent: string,
    ): string {
        const chatHash = createHash("sha256").update(chatId).digest("hex").slice(0, 8);
        return `neoclaw::${channel}::${chatHash}::${runId}::${stepId}::${agent}`;
    }

    /**
     * 确保底层 acpx 存在此 Session，并且没有被意外中断。
     * 如果开启了 autoEnsureSession 且探测不到该 Session，则执行 `acpx <agent> sessions ensure -s <name>`.
     */
    async ensureSession(sessionName: string, agent: string, cwd: string): Promise<void> {
        if (!this.config.autoEnsureSession) return;

        // acpx <agent> sessions ensure -s <sessionName>
        try {
            const result = await this.executor.execute({
                agent,
                prompt: `sessions ensure -s ${sessionName}`,
                cwd,
                mode: "exec" // ensure 命令在原生模式下执行
            });
            if (result.status !== "succeeded") {
                logger.warn("acp-router", `Failed to ensure session ${sessionName}: ${result.error}`);
            }
        } catch (e) {
            logger.warn("acp-router", `Cannot launch ACPX router ensure command: ${e}`);
        }
    }

    /**
     * 显式要求关闭 session 以回收资源
     */
    async closeSession(sessionName: string, agent: string, cwd: string): Promise<void> {
        try {
            const result = await this.executor.execute({
                agent,
                prompt: `sessions close -s ${sessionName}`,
                cwd,
                mode: "exec"
            });
            if (result.status !== "succeeded") {
                logger.debug("acp-router", `Session close returned non-success: ${result.error}`);
            }
        } catch (e) {
            // 忽略清理阶段的错误
        }
    }
}
