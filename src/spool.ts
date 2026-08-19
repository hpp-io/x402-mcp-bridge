/**
 * Large-payload spooling for paid-call results (and file refs for inputs).
 *
 * Media-shaped x402 services (TTS, image/doc generation) return payloads that
 * are useless — and expensive — inside an LLM loop: a single ~100KB base64
 * audio field is ~25k tokens, the model re-emits it trying to save a file,
 * and one paid call balloons into a 10-minute turn (observed live, 2026-08-19).
 * No other ecosystem passes media through the tool-result text: OpenAI-style
 * APIs return raw binary bodies or hosted URLs, dTelecom streams over WebRTC.
 *
 * The bridge is a local process on the agent's host, so it can do what a
 * hosted seller cannot: write the payload to a local file and hand the agent
 * a path. Two directions:
 *
 *   - results: any string field ≥ threshold is decoded (base64 → binary with
 *     magic-byte extension sniffing) and replaced with a `$spooled` descriptor;
 *     raw binary HTTP responses (Content-Type audio/*, image/* …) are spooled
 *     directly.
 *   - inputs: a body value of the form "@file:/abs/path" is replaced with the
 *     file's base64, so audio uploads (STT) never transit the model either.
 *
 * Generic by design — size + shape rules only, no service-specific fields.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { log } from "./log.js";

export interface SpoolConfig {
  enabled: boolean;
  thresholdBytes: number;
  dir: string;
  ttlHours: number;
  sessionCapBytes: number;
}

export function spoolConfig(): SpoolConfig {
  return {
    enabled: (process.env.HPP_X402_SPOOL ?? "on") !== "off",
    thresholdBytes: Number(process.env.HPP_X402_SPOOL_THRESHOLD_BYTES ?? 16_384),
    dir: process.env.HPP_X402_ARTIFACT_DIR ?? join(homedir() || tmpdir(), ".hpp-x402", "artifacts"),
    ttlHours: Number(process.env.HPP_X402_ARTIFACT_TTL_HOURS ?? 72),
    sessionCapBytes: Number(process.env.HPP_X402_SPOOL_SESSION_CAP_BYTES ?? 512 * 1024 * 1024),
  };
}

/** Replacement descriptor the model sees instead of the payload. */
export interface SpooledRef {
  $spooled: string;
  kind: string;
  bytes: number;
  sha256: string;
  preview: string;
  note: string;
}

const NOTE =
  "large payload saved locally by the bridge — use the file path; do not re-emit the content";

// ---------------------------------------------------------------- internals

let sessionSpooledBytes = 0;
let cleanedUp = false;

function ensureDir(cfg: SpoolConfig): void {
  mkdirSync(cfg.dir, { recursive: true, mode: 0o700 });
  if (cleanedUp) return;
  cleanedUp = true;
  // TTL sweep, once per process — artifacts are a hand-off, not an archive.
  const cutoff = Date.now() - cfg.ttlHours * 3600_000;
  try {
    for (const f of readdirSync(cfg.dir)) {
      const p = join(cfg.dir, f);
      try {
        if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
      } catch {
        /* races with concurrent bridges are fine */
      }
    }
  } catch {
    /* unreadable dir — spooling will surface the real error */
  }
}

/** Magic-byte sniffing for decoded payloads. Returns an extension. */
export function sniffKind(buf: Buffer): string {
  if (buf.length >= 3 && buf.toString("latin1", 0, 3) === "ID3") return "mp3";
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return "mp3";
  if (buf.length >= 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WAVE") return "wav";
  if (buf.length >= 4 && buf.toString("latin1", 0, 4) === "OggS") return "ogg";
  if (buf.length >= 4 && buf.toString("latin1", 0, 4) === "fLaC") return "flac";
  if (buf.length >= 8 && buf[0] === 0x89 && buf.toString("latin1", 1, 4) === "PNG") return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.length >= 12 && buf.toString("latin1", 8, 12) === "WEBP") return "webp";
  if (buf.length >= 5 && buf.toString("latin1", 0, 5) === "%PDF-") return "pdf";
  if (buf.length >= 4 && buf.toString("latin1", 0, 4) === "PK\x03\x04") return "zip";
  return "bin";
}

const BASE64_RE = /^[A-Za-z0-9+/=\r\n]+$/;

function tryDecodeBase64(s: string): Buffer | null {
  if (!BASE64_RE.test(s)) return null;
  const compact = s.replace(/\s+/g, "");
  if (compact.length % 4 !== 0) return null;
  const buf = Buffer.from(compact, "base64");
  // Round-trip sanity: Buffer.from(base64) is lenient about garbage.
  if (buf.length < (compact.length / 4) * 3 - 3) return null;
  return buf;
}

function writeArtifact(cfg: SpoolConfig, buf: Buffer, kind: string, tool: string): SpooledRef {
  ensureDir(cfg);
  if (sessionSpooledBytes + buf.length > cfg.sessionCapBytes) {
    throw new Error(`spool session cap exceeded (${cfg.sessionCapBytes} bytes)`);
  }
  const sha256 = createHash("sha256").update(buf).digest("hex");
  const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
  const path = join(cfg.dir, `${ts}-${tool}-${sha256.slice(0, 8)}.${kind}`);
  writeFileSync(path, buf, { mode: 0o600 });
  sessionSpooledBytes += buf.length;
  log.info("spool.written", { path, kind, bytes: buf.length, tool });
  return {
    $spooled: path,
    kind,
    bytes: buf.length,
    sha256,
    preview: buf.toString(kind === "bin" || kind === "txt" ? "utf8" : "base64").slice(0, 64),
    note: NOTE,
  };
}

function spoolString(cfg: SpoolConfig, s: string, tool: string): unknown {
  // JSON-in-string (e.g. an agent's stringified `output`) — unwrap, recurse,
  // re-stringify so small sibling fields stay inline and readable.
  try {
    const inner = JSON.parse(s);
    if (inner && typeof inner === "object") {
      return JSON.stringify(spoolWalk(cfg, inner, tool));
    }
  } catch {
    /* not JSON */
  }
  const decoded = tryDecodeBase64(s);
  if (decoded) return writeArtifact(cfg, decoded, sniffKind(decoded), tool);
  return writeArtifact(cfg, Buffer.from(s, "utf8"), "txt", tool);
}

function spoolWalk(cfg: SpoolConfig, value: unknown, tool: string): unknown {
  if (typeof value === "string") {
    return value.length >= cfg.thresholdBytes ? spoolString(cfg, value, tool) : value;
  }
  if (Array.isArray(value)) return value.map((v) => spoolWalk(cfg, v, tool));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = spoolWalk(cfg, v, tool);
    }
    return out;
  }
  return value;
}

// ------------------------------------------------------------------- public

/** Spool oversized string fields inside an already-parsed response value. */
export function spoolValue(value: unknown, tool: string): unknown {
  const cfg = spoolConfig();
  if (!cfg.enabled) return value;
  try {
    return spoolWalk(cfg, value, tool);
  } catch (err) {
    log.error("spool.failed", { tool, err: (err as Error).message });
    return value; // never let spooling break a paid result
  }
}

/** Spool a raw binary HTTP response body (Content-Type driven). */
export function spoolBinary(buf: Buffer, contentType: string, tool: string): SpooledRef | null {
  const cfg = spoolConfig();
  if (!cfg.enabled) return null;
  try {
    const sniffed = sniffKind(buf);
    const kind = sniffed !== "bin" ? sniffed : extFromContentType(contentType);
    return writeArtifact(cfg, buf, kind, tool);
  } catch (err) {
    log.error("spool.failed", { tool, err: (err as Error).message });
    return null;
  }
}

const BINARY_CT = /^(audio|image|video)\/|^application\/(pdf|octet-stream|zip)/i;

export function isBinaryContentType(contentType: string | null | undefined): boolean {
  return Boolean(contentType && BINARY_CT.test(contentType));
}

function extFromContentType(ct: string): string {
  const sub = ct.split(";")[0].split("/")[1] ?? "bin";
  return ({ mpeg: "mp3", "x-wav": "wav", jpeg: "jpg", "octet-stream": "bin" } as Record<string, string>)[sub] ?? sub;
}

/** Post-process a CallToolResult: spool oversized fields in its text items. */
export function spoolToolResult(result: CallToolResult, tool: string): CallToolResult {
  const cfg = spoolConfig();
  if (!cfg.enabled || result.isError) return result;
  const content = result.content.map((c) => {
    if (c.type !== "text" || typeof c.text !== "string" || c.text.length < cfg.thresholdBytes) return c;
    const out = spoolValue(
      (() => {
        try {
          return JSON.parse(c.text);
        } catch {
          return c.text;
        }
      })(),
      tool,
    );
    return { ...c, text: typeof out === "string" ? out : JSON.stringify(out) };
  });
  return { ...result, content };
}

const FILE_REF_PREFIX = "@file:";
const FILE_REF_MAX_BYTES = 8 * 1024 * 1024; // matches the selling agent's body cap

/**
 * Replace "@file:/abs/path" string values in a request body with the file's
 * base64, so large inputs (e.g. STT audio) never transit the model.
 */
export function resolveFileRefs(value: unknown): unknown {
  if (typeof value === "string" && value.startsWith(FILE_REF_PREFIX)) {
    const raw = value.slice(FILE_REF_PREFIX.length);
    if (!raw.startsWith("/")) throw new Error(`@file: path must be absolute: ${raw}`);
    const path = realpathSync(raw); // resolves symlinks; throws if missing
    const size = statSync(path).size;
    if (size > FILE_REF_MAX_BYTES) {
      throw new Error(`@file: ${path} is ${size} bytes (max ${FILE_REF_MAX_BYTES})`);
    }
    log.info("spool.fileRef", { path, bytes: size });
    return readFileSync(path).toString("base64");
  }
  if (Array.isArray(value)) return value.map(resolveFileRefs);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = resolveFileRefs(v);
    return out;
  }
  return value;
}

/** Test hook. */
export function resetSpoolSessionForTests(): void {
  sessionSpooledBytes = 0;
  cleanedUp = false;
}
