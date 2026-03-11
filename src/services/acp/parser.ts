import type { AcpEvent } from "./types.js";

/**
 * 从 acpx 子进程的 stdout/stderr 逐行解析 NDJSON 事件流。
 * 能够容忍混合输出或截断数据，仅严格解析合规的 JSON 行。
 * 
 * @param stream Node.js Readable 流 (如 subprocess.stdout)
 * @yields 解析成功且符合基本结构的 AcpEvent
 */
export async function* parseNdjsonStream(
    stream: NodeJS.ReadableStream
): AsyncGenerator<AcpEvent, void, unknown> {
    let buffer = "";

    for await (const chunk of stream) {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        // 保留最后一行（可能被截断未含 \n 结尾的碎片）
        buffer = lines.pop() ?? "";

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("{") || !trimmed.endsWith("}")) {
                // 非合规 JSON 行或启动杂项打印，直接跳过保护解析器不崩溃
                continue;
            }

            try {
                const parsed = JSON.parse(trimmed);

                // 简单鸭子类型验证是否符合 AcpEvent 的基础骨架
                if (parsed && typeof parsed === "object" && "type" in parsed && "timestamp" in parsed) {
                    yield parsed as AcpEvent;
                }
            } catch (e) {
                // 静默：偶尔发生 JSON 内部畸变时跳过
            }
        }
    }

    // 处理在流结束时可能遗留在 buffer 中的合规末行
    const finalTrimmed = buffer.trim();
    if (finalTrimmed && finalTrimmed.startsWith("{") && finalTrimmed.endsWith("}")) {
        try {
            const parsed = JSON.parse(finalTrimmed);
            if (parsed && typeof parsed === "object" && "type" in parsed && "timestamp" in parsed) {
                yield parsed as AcpEvent;
            }
        } catch {
            // 忽略落幕时的不合规尾部
        }
    }
}
