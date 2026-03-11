import { describe, expect, it } from "bun:test";
import { parseNdjsonStream } from "../parser.js";
import { AcpError, isRetryableError } from "../errors.js";

function createMockStream(chunks: string[]): NodeJS.ReadableStream {
    let idx = 0;
    return {
        [Symbol.asyncIterator]() {
            return {
                async next() {
                    if (idx >= chunks.length) {
                        return { done: true, value: undefined };
                    }
                    return { done: false, value: Buffer.from(chunks[idx++]) };
                }
            };
        }
    } as NodeJS.ReadableStream;
}

describe("Acp Error Handling", () => {
    it("determines retryable errors correctly", () => {
        expect(isRetryableError("SESSION_LOST")).toBe(true);
        expect(isRetryableError("TIMEOUT")).toBe(true);
        expect(isRetryableError("SPAWN_FAILED")).toBe(true);
        expect(isRetryableError("PERMISSION_DENIED")).toBe(false);
        expect(isRetryableError("AGENT_ERROR")).toBe(false);
    });

    it("can construct error object with retry flag", () => {
        const err = new AcpError("TIMEOUT", "Took too long", true);
        expect(err.code).toBe("TIMEOUT");
        expect(err.message).toBe("Took too long");
    });
});

describe("Ndjson Parser", () => {
    it("parses valid ndjson stream completely", async () => {
        const stream = createMockStream([
            '{"type":"start","timestamp":"1","data":{}}\n{"type":"progress","timestamp"',
            ':"2","data":{}}\n{"type":"result","timestamp":"3","data":{"text":"hello"}}\n'
        ]);

        const events = [];
        for await (const ev of parseNdjsonStream(stream)) {
            events.push(ev);
        }

        expect(events).toEqual([
            { type: "start", timestamp: "1", data: {} },
            { type: "progress", timestamp: "2", data: {} },
            { type: "result", timestamp: "3", data: { text: "hello" } }
        ]);
    });

    it("filters out noisy non-json starter logs", async () => {
        const stream = createMockStream([
            'acpx version 1.0 starting up...\n',
            'warning: something is slow today\n',
            '{"type":"start","timestamp":"1","data":{}}\n'
        ]);

        const events = [];
        for await (const ev of parseNdjsonStream(stream)) {
            events.push(ev);
        }

        expect(events.length).toBe(1);
        expect(events[0].type).toBe("start");
    });

    it("safely handles fragmented malformed json within chunks", async () => {
        const stream = createMockStream([
            '{"type":"start","timestamp":"1","data":{}}\n',
            '{"type": "error", "timestamp"',
            ' broken json here }\n',
            '{"type":"result","timestamp":"2","data":{}}\n'
        ]);

        const events = [];
        for await (const ev of parseNdjsonStream(stream)) {
            events.push(ev);
        }

        // 应该只收到头尾两条好的，中间坏的不崩溃直接丢弃
        expect(events.length).toBe(2);
        expect(events[0].timestamp).toBe("1");
        expect(events[1].timestamp).toBe("2");
    });
});
