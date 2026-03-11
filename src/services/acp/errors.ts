export type AcpErrorCode =
    | "CONFIG_ERROR"
    | "CWD_OUT_OF_BOUNDS"
    | "PERMISSION_DENIED"
    | "SPAWN_FAILED"
    | "SESSION_LOST"
    | "PARSE_ERROR"
    | "TIMEOUT"
    | "AGENT_ERROR"
    | "CANCELLED";

export class AcpError extends Error {
    constructor(
        public code: AcpErrorCode,
        message: string,
        public retryable: boolean = false,
    ) {
        super(message);
        this.name = "AcpError";
    }
}

/** 判断错误是否可通过重试解决 */
export function isRetryableError(code: AcpErrorCode): boolean {
    return ["SESSION_LOST", "SPAWN_FAILED", "TIMEOUT"].includes(code);
}
