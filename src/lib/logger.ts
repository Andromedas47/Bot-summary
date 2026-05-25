type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info:  1,
  warn:  2,
  error: 3,
};

function currentLevel(): LogLevel {
  const env = process.env.LOG_LEVEL?.toLowerCase();
  if (env === "debug" || env === "info" || env === "warn" || env === "error") {
    return env;
  }
  return process.env.NODE_ENV === "production" ? "info" : "debug";
}

function log(level: LogLevel, message: string, context?: Record<string, unknown>) {
  if (LEVELS[level] < LEVELS[currentLevel()]) return;

  const entry = {
    ts:  new Date().toISOString(),
    lvl: level,
    msg: message,
    ...context,
  };

  const line = process.env.NODE_ENV === "production"
    ? JSON.stringify(entry)
    : `[${entry.ts}] ${level.toUpperCase().padEnd(5)} ${message}${context ? " " + JSON.stringify(context) : ""}`;

  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug: (msg: string, ctx?: Record<string, unknown>) => log("debug", msg, ctx),
  info:  (msg: string, ctx?: Record<string, unknown>) => log("info",  msg, ctx),
  warn:  (msg: string, ctx?: Record<string, unknown>) => log("warn",  msg, ctx),
  error: (msg: string, ctx?: Record<string, unknown>) => log("error", msg, ctx),

  child(base: Record<string, unknown>) {
    return {
      debug: (msg: string, ctx?: Record<string, unknown>) => log("debug", msg, { ...base, ...ctx }),
      info:  (msg: string, ctx?: Record<string, unknown>) => log("info",  msg, { ...base, ...ctx }),
      warn:  (msg: string, ctx?: Record<string, unknown>) => log("warn",  msg, { ...base, ...ctx }),
      error: (msg: string, ctx?: Record<string, unknown>) => log("error", msg, { ...base, ...ctx }),
    };
  },
};
