import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type { ChannelName } from "../bus/types.js";

export interface RuntimeErrorEntry {
  time: string;
  scope: string;
  message: string;
}

export interface UsageCounters {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requests: number;
}

export interface DailyUsageBucket extends UsageCounters {
  date: string;
}

export interface HourlyUsageBucket extends UsageCounters {
  hour: string;
}

export interface RuntimeUsageSnapshot {
  updatedAt?: string;
  totals: UsageCounters;
  daily: DailyUsageBucket[];
  hourly: HourlyUsageBucket[];
}

export interface UsageRecordInput {
  inputTokens?: number;
  outputTokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  requests?: number;
}

export interface ChannelRuntimeStatus {
  configuredEnabled: boolean;
  running: boolean;
  lastStartAt?: string;
  lastStopAt?: string;
  lastErrorAt?: string;
  lastError?: string;
}

export interface RuntimeStatusSnapshot {
  updatedAt: string;
  agent: {
    running: boolean;
    pid: number | null;
    startedAt?: string;
    stoppedAt?: string;
    profileDir?: string;
  };
  channels: Record<string, ChannelRuntimeStatus>;
  recentErrors: RuntimeErrorEntry[];
  usage: RuntimeUsageSnapshot;
}

const MAX_ERRORS = 60;
const MAX_DAILY_BUCKETS = 14;
const MAX_HOURLY_BUCKETS = 24;

function nowIso(): string {
  return new Date().toISOString();
}

function asMessage(err: unknown): string {
  if (!err) return "unknown error";
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message || String(err);
  return String(err);
}

function createEmptySnapshot(profileDir?: string): RuntimeStatusSnapshot {
  return {
    updatedAt: nowIso(),
    agent: {
      running: false,
      pid: null,
      profileDir,
    },
    channels: {},
    recentErrors: [],
    usage: createEmptyUsage(),
  };
}

function createEmptyCounters(): UsageCounters {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    requests: 0,
  };
}

function createEmptyUsage(): RuntimeUsageSnapshot {
  return {
    updatedAt: undefined,
    totals: createEmptyCounters(),
    daily: [],
    hourly: [],
  };
}

function formatDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatHourKey(date: Date): string {
  return `${formatDateKey(date)}T${String(date.getHours()).padStart(2, "0")}:00`;
}

function asNonNegativeInt(value: unknown): number {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function cloneCounters(input?: Partial<UsageCounters> | null): UsageCounters {
  return {
    inputTokens: asNonNegativeInt(input?.inputTokens),
    outputTokens: asNonNegativeInt(input?.outputTokens),
    totalTokens: asNonNegativeInt(input?.totalTokens),
    requests: asNonNegativeInt(input?.requests),
  };
}

function normalizeUsage(raw?: Partial<RuntimeUsageSnapshot> | null): RuntimeUsageSnapshot {
  return {
    updatedAt: typeof raw?.updatedAt === "string" ? raw.updatedAt : undefined,
    totals: cloneCounters(raw?.totals),
    daily: Array.isArray(raw?.daily)
      ? raw!.daily
        .filter((entry): entry is DailyUsageBucket => !!entry && typeof entry.date === "string")
        .map((entry) => ({ date: entry.date, ...cloneCounters(entry) }))
        .slice(-MAX_DAILY_BUCKETS)
      : [],
    hourly: Array.isArray(raw?.hourly)
      ? raw!.hourly
        .filter((entry): entry is HourlyUsageBucket => !!entry && typeof entry.hour === "string")
        .map((entry) => ({ hour: entry.hour, ...cloneCounters(entry) }))
        .slice(-MAX_HOURLY_BUCKETS)
      : [],
  };
}

function incrementCounters(target: UsageCounters, inputTokens: number, outputTokens: number, requests: number): void {
  target.inputTokens += inputTokens;
  target.outputTokens += outputTokens;
  target.totalTokens += inputTokens + outputTokens;
  target.requests += requests;
}

export function runtimeStatusPath(baseDir: string): string {
  return join(baseDir, "runtime-status.json");
}

export function readRuntimeStatusSnapshot(baseDir: string): RuntimeStatusSnapshot {
  const path = runtimeStatusPath(baseDir);
  if (!existsSync(path)) return createEmptySnapshot(baseDir);
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as RuntimeStatusSnapshot;
    if (!raw || typeof raw !== "object") return createEmptySnapshot(baseDir);
    return {
      ...createEmptySnapshot(baseDir),
      ...raw,
      agent: { ...createEmptySnapshot(baseDir).agent, ...(raw.agent || {}) },
      channels: { ...(raw.channels || {}) },
      recentErrors: Array.isArray(raw.recentErrors) ? raw.recentErrors.slice(-MAX_ERRORS) : [],
      usage: normalizeUsage(raw.usage),
      updatedAt: raw.updatedAt || nowIso(),
    };
  } catch {
    return createEmptySnapshot(baseDir);
  }
}

export class RuntimeStatusStore {
  private readonly path: string;
  private snapshot: RuntimeStatusSnapshot;

  constructor(private baseDir: string) {
    this.path = runtimeStatusPath(baseDir);
    this.snapshot = readRuntimeStatusSnapshot(baseDir);
    this.snapshot.agent.profileDir = baseDir;
  }

  markAgentRunning(): void {
    this.snapshot.agent.running = true;
    this.snapshot.agent.pid = process.pid;
    this.snapshot.agent.startedAt = nowIso();
    this.snapshot.agent.stoppedAt = undefined;
    this.persist();
  }

  markAgentStopped(): void {
    this.snapshot.agent.running = false;
    this.snapshot.agent.pid = null;
    this.snapshot.agent.stoppedAt = nowIso();
    this.persist();
  }

  markChannelConfigured(channel: ChannelName, enabled: boolean): void {
    const current = this.snapshot.channels[channel] || { configuredEnabled: false, running: false };
    this.snapshot.channels[channel] = {
      ...current,
      configuredEnabled: enabled,
    };
    this.persist();
  }

  markChannelRunning(channel: ChannelName, running: boolean): void {
    const current = this.snapshot.channels[channel] || { configuredEnabled: false, running: false };
    this.snapshot.channels[channel] = {
      ...current,
      running,
      lastStartAt: running ? nowIso() : current.lastStartAt,
      lastStopAt: running ? current.lastStopAt : nowIso(),
    };
    this.persist();
  }

  markChannelError(channel: ChannelName, err: unknown): void {
    const msg = asMessage(err);
    const current = this.snapshot.channels[channel] || { configuredEnabled: false, running: false };
    this.snapshot.channels[channel] = {
      ...current,
      lastErrorAt: nowIso(),
      lastError: msg,
    };
    this.pushError(`channel:${channel}`, msg);
    this.persist();
  }

  recordUsage(usage: UsageRecordInput): void {
    const inputTokens = asNonNegativeInt(usage.inputTokens ?? usage.input_tokens);
    const outputTokens = asNonNegativeInt(usage.outputTokens ?? usage.output_tokens);
    const requests = usage.requests === undefined ? 1 : asNonNegativeInt(usage.requests);
    if (inputTokens <= 0 && outputTokens <= 0 && requests <= 0) return;

    const now = new Date();
    const date = formatDateKey(now);
    const hour = formatHourKey(now);

    incrementCounters(this.snapshot.usage.totals, inputTokens, outputTokens, requests);

    let dailyBucket = this.snapshot.usage.daily.find((entry) => entry.date === date);
    if (!dailyBucket) {
      dailyBucket = { date, ...createEmptyCounters() };
      this.snapshot.usage.daily.push(dailyBucket);
      this.snapshot.usage.daily = this.snapshot.usage.daily.slice(-MAX_DAILY_BUCKETS);
    }
    incrementCounters(dailyBucket, inputTokens, outputTokens, requests);

    let hourlyBucket = this.snapshot.usage.hourly.find((entry) => entry.hour === hour);
    if (!hourlyBucket) {
      hourlyBucket = { hour, ...createEmptyCounters() };
      this.snapshot.usage.hourly.push(hourlyBucket);
      this.snapshot.usage.hourly = this.snapshot.usage.hourly.slice(-MAX_HOURLY_BUCKETS);
    }
    incrementCounters(hourlyBucket, inputTokens, outputTokens, requests);

    this.snapshot.usage.updatedAt = nowIso();
    this.persist();
  }

  pushError(scope: string, err: unknown): void {
    const msg = asMessage(err);
    this.snapshot.recentErrors.push({
      time: nowIso(),
      scope,
      message: msg,
    });
    if (this.snapshot.recentErrors.length > MAX_ERRORS) {
      this.snapshot.recentErrors = this.snapshot.recentErrors.slice(-MAX_ERRORS);
    }
    this.persist();
  }

  getSnapshot(): RuntimeStatusSnapshot {
    return {
      ...this.snapshot,
      agent: { ...this.snapshot.agent },
      channels: { ...this.snapshot.channels },
      recentErrors: this.snapshot.recentErrors.map((x) => ({ ...x })),
      usage: {
        updatedAt: this.snapshot.usage.updatedAt,
        totals: { ...this.snapshot.usage.totals },
        daily: this.snapshot.usage.daily.map((entry) => ({ ...entry })),
        hourly: this.snapshot.usage.hourly.map((entry) => ({ ...entry })),
      },
    };
  }

  private persist(): void {
    this.snapshot.updatedAt = nowIso();
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.snapshot, null, 2), "utf-8");
  }
}
