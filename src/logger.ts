export type LogLevelName = "debug" | "info" | "warn" | "error" | "silent";

const LEVEL_RANK: Record<LogLevelName, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

function parseLogLevel(raw: string | undefined): LogLevelName {
  const n = (raw ?? "info").toLowerCase().trim();
  if (n === "debug" || n === "info" || n === "warn" || n === "error" || n === "silent") {
    return n;
  }
  return "info";
}

export interface Logger {
  readonly level: LogLevelName;
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

function formatMeta(meta: unknown): string {
  if (meta === undefined || meta === "") return "";
  if (typeof meta === "string") return ` ${meta}`;
  try {
    return ` ${JSON.stringify(meta)}`;
  } catch {
    return ` ${String(meta)}`;
  }
}

export function createLogger(levelRaw: string | undefined): Logger {
  const level = parseLogLevel(levelRaw);
  const min = LEVEL_RANK[level];

  const log =
    (severity: LogLevelName, fn: typeof console.log) =>
    (msg: string, meta?: unknown) => {
      if (LEVEL_RANK[severity] < min) return;
      const line = `[${new Date().toISOString()}] [${severity.toUpperCase()}] ${msg}${formatMeta(meta)}`;
      fn(line);
    };

  return {
    level,
    debug: log("debug", console.log),
    info: log("info", console.log),
    warn: log("warn", console.warn),
    error: log("error", console.error),
  };
}
