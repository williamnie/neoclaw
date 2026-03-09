import type { SDKSession } from "@neovate/code";
import type { OutboundMessage } from "../bus/types.js";
import { logger } from "../logger.js";
import type { UsageRecordInput } from "../runtime/status-store.js";

export async function* processStream(
  session: SDKSession,
  reply: (content: string, progress?: boolean) => OutboundMessage,
  onUsage?: (usage: UsageRecordInput) => void,
): AsyncGenerator<OutboundMessage, string> {
  let finalContent = "";
  const emittedUsage = new Set<string>();
  let countedRequest = false;

  const emitUsage = (usage?: UsageRecordInput, options?: { countRequest?: boolean }) => {
    const inputTokens = Number(usage?.inputTokens ?? usage?.input_tokens ?? 0) || 0;
    const outputTokens = Number(usage?.outputTokens ?? usage?.output_tokens ?? 0) || 0;
    const countRequest = options?.countRequest ?? false;
    const key = `${inputTokens}:${outputTokens}:${countRequest ? 1 : 0}`;
    if (emittedUsage.has(key)) return;
    emittedUsage.add(key);
    onUsage?.({
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      requests: countRequest ? 1 : 0,
    });
    if (countRequest) countedRequest = true;
  };

  for await (const m of session.receive()) {
    if (m.type === "system") {
      logger.debug("agent", `init session=${m.sessionId} model=${m.model} tools=${m.tools.join(",")}`);

    } else if (m.type === "message" && "role" in m && m.role === "assistant") {
      if ((m as any).usage) {
        emitUsage((m as any).usage, { countRequest: true });
      }
      if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (part.type === "text" && part.text) {
            yield reply(part.text, true);
          } else if (part.type === "reasoning" && part.text) {
            logger.debug("agent", `thinking: ${part.text.slice(0, 120)}`);
            yield reply(part.text, true);
          } else if (part.type === "tool_use") {
            logger.debug("agent", `tool_use: ${part.displayName || part.name} id=${part.id} input=${JSON.stringify(part.input).slice(0, 100)}`);
          }
        }
      } else {
        const text = m.text || (typeof m.content === "string" ? m.content : "");
        if (text) yield reply(text, true);
      }

    } else if (m.type === "message" && "role" in m && (m.role === "tool" || m.role === "user")) {
      const parts = Array.isArray(m.content) ? m.content : [];
      for (const part of parts) {
        if ("name" in part) {
          const status = (part as any).result?.isError ? "error" : "ok";
          logger.debug("agent", `tool_result: ${(part as any).name} status=${status}`);
        }
      }

    } else if (m.type === "result") {
      finalContent = m.content;
      const status = m.isError ? "error" : "success";
      logger.debug("agent", `result: ${status} content=${JSON.stringify(finalContent).slice(0, 80)}`);
      if ((m as any).usage) {
        logger.info("agent", `usage: in=${(m as any).usage.input_tokens} out=${(m as any).usage.output_tokens}`);
        emitUsage((m as any).usage, { countRequest: true });
      } else if (!countedRequest) {
        emitUsage({ input_tokens: 0, output_tokens: 0 }, { countRequest: true });
      }
    }
  }

  return finalContent;
}
