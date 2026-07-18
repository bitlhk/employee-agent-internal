import { EventEmitter } from "events";
import { PassThrough } from "stream";
import { spawn } from "child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeBase64Strict, scanUploadForMalware, validateUploadContent } from "./upload-security";

vi.mock("child_process", () => ({ spawn: vi.fn() }));

function scannerProcess(exitCode: number) {
  const child = new EventEmitter() as any;
  child.stdin = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  queueMicrotask(() => child.emit("close", exitCode));
  return child;
}

afterEach(() => {
  delete process.env.UPLOAD_ANTIVIRUS_MODE;
  delete process.env.CLAMAV_COMMAND;
  delete process.env.CLAMAV_TIMEOUT_MS;
  vi.resetAllMocks();
});

describe("upload content validation", () => {
  it("rejects malformed base64", () => {
    expect(decodeBase64Strict("%%%not-base64%%%" )).toBeNull();
    expect(decodeBase64Strict(Buffer.from("ok").toString("base64"))?.toString()).toBe("ok");
  });
  it("rejects extension spoofing", () => {
    expect(validateUploadContent("png", Buffer.from("not an image"))).toEqual({ ok: false, error: "invalid PNG signature" });
    expect(validateUploadContent("pdf", Buffer.from("plain text"))).toEqual({ ok: false, error: "invalid PDF signature" });
  });

  it("accepts matching signatures", () => {
    expect(validateUploadContent("png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]))).toEqual({ ok: true });
    expect(validateUploadContent("pdf", Buffer.from("%PDF-1.7\n"))).toEqual({ ok: true });
  });

  it("validates common audio and video signatures", () => {
    expect(validateUploadContent("mp3", Buffer.from("ID3payload"))).toEqual({ ok: true });
    expect(validateUploadContent("wav", Buffer.from("RIFF0000WAVEpayload"))).toEqual({ ok: true });
    expect(validateUploadContent("mp4", Buffer.from("0000ftypisom"))).toEqual({ ok: true });
    expect(validateUploadContent("ogg", Buffer.from("OggSpayload"))).toEqual({ ok: true });
    expect(validateUploadContent("webm", Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00]))).toEqual({ ok: true });
  });

  it("rejects active HTML and SVG content", () => {
    expect(validateUploadContent("html", Buffer.from("<script>alert(1)</script>"))).toEqual({ ok: false, error: "active scriptable markup is not allowed" });
    expect(validateUploadContent("svg", Buffer.from("<svg><image href=\"https://evil.example/x\"/></svg>"))).toEqual({ ok: false, error: "SVG external content is not allowed" });
  });

  it("skips the scanner when antivirus is disabled", async () => {
    process.env.UPLOAD_ANTIVIRUS_MODE = "disabled";
    await expect(scanUploadForMalware(Buffer.from("safe"))).resolves.toEqual({ ok: true });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("uses the daemon scanner asynchronously and blocks malware", async () => {
    process.env.UPLOAD_ANTIVIRUS_MODE = "required";
    vi.mocked(spawn).mockReturnValueOnce(scannerProcess(0));
    await expect(scanUploadForMalware(Buffer.from("safe"))).resolves.toEqual({ ok: true });
    expect(spawn).toHaveBeenCalledWith("clamdscan", ["--no-summary", "-"], { stdio: ["pipe", "ignore", "pipe"] });

    vi.mocked(spawn).mockReturnValueOnce(scannerProcess(1));
    await expect(scanUploadForMalware(Buffer.from("eicar"))).resolves.toEqual({ ok: false, error: "malware detected" });
  });

  it("fails closed when the required scanner is unavailable", async () => {
    process.env.UPLOAD_ANTIVIRUS_MODE = "required";
    vi.mocked(spawn).mockReturnValueOnce(scannerProcess(2));
    await expect(scanUploadForMalware(Buffer.from("safe"))).resolves.toEqual({ ok: false, error: "antivirus scan unavailable" });
  });
});
