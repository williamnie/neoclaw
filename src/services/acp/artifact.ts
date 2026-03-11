import { join, resolve } from "path";
import { writeFileSync, readFileSync, mkdirSync } from "fs";
import type { StepManifest } from "./types.js";

export class AcpArtifactManager {
    constructor(private artifactBaseDir: string) {
        mkdirSync(this.artifactBaseDir, { recursive: true });
    }

    /** 获取单次 run 的基础工件隔离路径 */
    getRunDir(runId: string): string {
        const p = join(this.artifactBaseDir, runId);
        mkdirSync(p, { recursive: true });
        return p;
    }

    /** 获取单个步骤的隔离路径 */
    getStepDir(runId: string, stepId: string): string {
        const p = join(this.getRunDir(runId), "steps", stepId);
        mkdirSync(p, { recursive: true });
        return p;
    }

    /** 向文件系统写入该步骤的 Manifest 并进行物理隔离交接契约 */
    writeManifest(runId: string, manifest: StepManifest): string {
        const stepDir = this.getStepDir(runId, manifest.stepId);
        const path = join(stepDir, "manifest.json");
        writeFileSync(path, JSON.stringify(manifest, null, 2), "utf-8");
        return path;
    }

    /** 读取某一步的 Manifest */
    readManifest(runId: string, stepId: string): StepManifest | undefined {
        try {
            const stepDir = this.getStepDir(runId, stepId);
            const path = join(stepDir, "manifest.json");
            const content = readFileSync(path, "utf-8");
            return JSON.parse(content) as StepManifest;
        } catch (e) {
            return undefined;
        }
    }

    /**
     * 构建提供给下游 Agent 使用的安全 Context，基于严格的 Artifact Hand-off Contract
     * 取决于被提供的上游 manifests 数组。
     */
    buildDownstreamPrompt(goalPrompt: string, upstreamManifests: StepManifest[]): string {
        const contextSections = upstreamManifests.flatMap((m) =>
            m.coreOutputs.map((o) => {
                // o.path 需保证是绝对路径或相对此 artifactBaseDir 可解
                try {
                    // 在生产中需要防范 Path Traversal，但这里内部生成较为可控
                    const content = readFileSync(o.path, "utf-8");
                    return `## [Upstream: ${m.stepId}] ${o.description}\n\`\`\`text\n${content}\n\`\`\``;
                } catch (err) {
                    return `## [Upstream: ${m.stepId}] ${o.description}\n(Error reading context file: ${err})`;
                }
            })
        );

        const sections = [];
        sections.push("# 任务主目标");
        sections.push(goalPrompt);
        sections.push("");

        if (contextSections.length > 0) {
            sections.push("# 上游交接上下文（只读，应当被严格遵循而不可修改历史规范）");
            sections.push(...contextSections);
        }

        return sections.join("\n");
    }
}
