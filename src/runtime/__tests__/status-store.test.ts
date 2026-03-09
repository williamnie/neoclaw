import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, rmSync } from "fs";
import { join } from "path";
import { readRuntimeStatusSnapshot, RuntimeStatusStore } from "../status-store.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0, tmpDirs.length)) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

describe("RuntimeStatusStore", () => {
  it("tracks agent/channel state and recent errors", () => {
    const baseDir = join("/tmp", `neoclaw-runtime-status-${Date.now()}`);
    tmpDirs.push(baseDir);
    const store = new RuntimeStatusStore(baseDir);

    store.markAgentRunning();
    store.recordUsage({ input_tokens: 12, output_tokens: 7 });
    store.markChannelConfigured("feishu", true);
    store.markChannelRunning("feishu", true);
    store.markChannelError("feishu", new Error("ws failed"));
    store.pushError("main:test", "synthetic");
    store.markChannelRunning("feishu", false);
    store.markAgentStopped();

    const snap = readRuntimeStatusSnapshot(baseDir);
    expect(snap.agent.running).toBe(false);
    expect(snap.channels.feishu.configuredEnabled).toBe(true);
    expect(snap.channels.feishu.running).toBe(false);
    expect(snap.channels.feishu.lastError).toContain("ws failed");
    expect(snap.recentErrors.length).toBeGreaterThan(0);
    expect(snap.usage.totals.inputTokens).toBe(12);
    expect(snap.usage.totals.outputTokens).toBe(7);
    expect(snap.usage.totals.totalTokens).toBe(19);
    expect(snap.usage.totals.requests).toBe(1);
    expect(snap.usage.daily.length).toBe(1);
  });

  it("counts requests even when token usage is unavailable", () => {
    const baseDir = join("/tmp", `neoclaw-runtime-status-${Date.now()}-requests`);
    tmpDirs.push(baseDir);
    const store = new RuntimeStatusStore(baseDir);

    store.recordUsage({ requests: 1 });

    const snap = readRuntimeStatusSnapshot(baseDir);
    expect(snap.usage.totals.requests).toBe(1);
    expect(snap.usage.totals.totalTokens).toBe(0);
    expect(snap.usage.daily.length).toBe(1);
  });

});
