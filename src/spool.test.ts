import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isBinaryContentType,
  resolveFileRefs,
  resetSpoolSessionForTests,
  sniffKind,
  spoolBinary,
  spoolToolResult,
  spoolValue,
} from "./spool.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "spool-test-"));
  process.env.HPP_X402_ARTIFACT_DIR = dir;
  process.env.HPP_X402_SPOOL = "on";
  process.env.HPP_X402_SPOOL_THRESHOLD_BYTES = "1024";
  delete process.env.HPP_X402_SPOOL_SESSION_CAP_BYTES;
  resetSpoolSessionForTests();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HPP_X402_ARTIFACT_DIR;
  delete process.env.HPP_X402_SPOOL;
  delete process.env.HPP_X402_SPOOL_THRESHOLD_BYTES;
});

/** A valid mp3-magic payload, base64-encoded, comfortably over threshold. */
function bigMp3B64(): { b64: string; raw: Buffer } {
  const raw = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(4000, 7)]);
  return { b64: raw.toString("base64"), raw };
}

describe("spoolValue", () => {
  it("leaves small fields and non-strings untouched", () => {
    const v = { text: "hello", n: 5, list: [1, "two"] };
    expect(spoolValue(v, "t")).toEqual(v);
  });

  it("spools an oversized base64 field to a sniffed binary file", () => {
    const { b64, raw } = bigMp3B64();
    const out = spoolValue({ audio_b64: b64, duration_s: 6.9 }, "t") as any;
    expect(out.duration_s).toBe(6.9);
    const ref = out.audio_b64;
    expect(ref.$spooled).toContain(dir);
    expect(ref.$spooled.endsWith(".mp3")).toBe(true);
    expect(ref.bytes).toBe(raw.length);
    expect(ref.note).toContain("do not re-emit");
    expect(readFileSync(ref.$spooled).equals(raw)).toBe(true);
  });

  it("unwraps JSON-in-string and keeps small siblings inline", () => {
    const { b64 } = bigMp3B64();
    const inner = JSON.stringify({ audio_b64: b64, engine: "melotts" });
    const out = spoolValue({ jobId: "j1", output: inner }, "t") as any;
    expect(out.jobId).toBe("j1");
    const reparsed = JSON.parse(out.output);
    expect(reparsed.engine).toBe("melotts");
    expect(reparsed.audio_b64.$spooled.endsWith(".mp3")).toBe(true);
  });

  it("spools oversized non-base64 text as .txt", () => {
    const out = spoolValue({ blob: "한국어 텍스트 ".repeat(200) }, "t") as any;
    expect(out.blob.$spooled.endsWith(".txt")).toBe(true);
    expect(out.blob.kind).toBe("txt");
  });

  it("is a no-op when HPP_X402_SPOOL=off", () => {
    process.env.HPP_X402_SPOOL = "off";
    const { b64 } = bigMp3B64();
    expect((spoolValue({ audio_b64: b64 }, "t") as any).audio_b64).toBe(b64);
  });

  it("stops spooling past the session cap but never throws", () => {
    process.env.HPP_X402_SPOOL_SESSION_CAP_BYTES = "100";
    const { b64 } = bigMp3B64();
    const out = spoolValue({ audio_b64: b64 }, "t") as any;
    expect(out.audio_b64).toBe(b64); // cap hit → original value returned
  });
});

describe("sniffKind / binary responses", () => {
  it("sniffs common magics", () => {
    expect(sniffKind(Buffer.concat([Buffer.from("RIFF1234WAVE"), Buffer.alloc(8)]))).toBe("wav");
    expect(sniffKind(Buffer.concat([Buffer.from([0x89]), Buffer.from("PNG\r\n"), Buffer.alloc(8)]))).toBe("png");
    expect(sniffKind(Buffer.from("%PDF-1.7 …"))).toBe("pdf");
    expect(sniffKind(Buffer.alloc(16, 1))).toBe("bin");
  });

  it("classifies media content types", () => {
    expect(isBinaryContentType("audio/mpeg")).toBe(true);
    expect(isBinaryContentType("image/png")).toBe(true);
    expect(isBinaryContentType("application/pdf")).toBe(true);
    expect(isBinaryContentType("application/json")).toBe(false);
    expect(isBinaryContentType(null)).toBe(false);
  });

  it("spools a raw binary body with a content-type fallback extension", () => {
    const ref = spoolBinary(Buffer.alloc(2048, 3), "audio/mpeg", "t");
    expect(ref?.$spooled.endsWith(".mp3")).toBe(true);
    expect(existsSync(ref!.$spooled)).toBe(true);
  });
});

describe("spoolToolResult", () => {
  it("rewrites oversized text content and leaves errors alone", () => {
    const { b64 } = bigMp3B64();
    const big = JSON.stringify({ output: { audio_b64: b64 } });
    const ok = spoolToolResult({ content: [{ type: "text", text: big }] }, "t");
    const parsed = JSON.parse((ok.content[0] as any).text);
    expect(parsed.output.audio_b64.$spooled).toBeTruthy();

    const err = spoolToolResult({ content: [{ type: "text", text: big }], isError: true }, "t");
    expect((err.content[0] as any).text).toBe(big);
  });
});

describe("resolveFileRefs", () => {
  it("replaces @file: values with the file's base64", () => {
    const f = join(dir, "in.wav");
    const raw = Buffer.concat([Buffer.from("RIFF1234WAVE"), Buffer.alloc(100, 9)]);
    writeFileSync(f, raw);
    const out = resolveFileRefs({ audio_b64: `@file:${f}`, language: "auto" }) as any;
    expect(out.language).toBe("auto");
    expect(Buffer.from(out.audio_b64, "base64").equals(raw)).toBe(true);
  });

  it("rejects relative paths and missing files", () => {
    expect(() => resolveFileRefs({ a: "@file:relative.wav" })).toThrow(/absolute/);
    expect(() => resolveFileRefs({ a: `@file:${join(dir, "nope.wav")}` })).toThrow();
  });

  it("rejects oversized files", () => {
    const f = join(dir, "big.bin");
    writeFileSync(f, Buffer.alloc(9 * 1024 * 1024));
    expect(() => resolveFileRefs({ a: `@file:${f}` })).toThrow(/max/);
  });
});
