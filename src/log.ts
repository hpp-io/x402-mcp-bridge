/**
 * stderr-only logger.
 *
 * stdin/stdout are reserved for the MCP JSON-RPC protocol; any log line
 * on stdout corrupts the protocol stream and will crash the host. All
 * logging goes to stderr (which Claude Desktop / OpenClaw discard or
 * route to their own debug output).
 */
type Level = "off" | "info" | "debug";

const order: Record<Level, number> = { off: 0, info: 1, debug: 2 };

let current: Level = "info";

export function setLogLevel(level: Level): void {
  current = level;
}

function emit(level: Level, msg: string, extra?: Record<string, unknown>): void {
  if (order[current] < order[level]) return;
  const line = extra
    ? `[${level}] ${msg} ${JSON.stringify(extra)}`
    : `[${level}] ${msg}`;
  process.stderr.write(line + "\n");
}

export const log = {
  info: (msg: string, extra?: Record<string, unknown>) => emit("info", msg, extra),
  debug: (msg: string, extra?: Record<string, unknown>) =>
    emit("debug", msg, extra),
  error: (msg: string, extra?: Record<string, unknown>) => {
    // Errors always emit, regardless of level (off still suppresses).
    if (current === "off") return;
    process.stderr.write(
      `[error] ${msg}` + (extra ? " " + JSON.stringify(extra) : "") + "\n",
    );
  },
};
