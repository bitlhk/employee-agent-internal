import { describe, expect, it } from "vitest";
import { downsampleToPcm16 } from "./realtime-voice";

describe("downsampleToPcm16", () => {
  it("downsamples browser audio to signed 16-bit PCM", () => {
    const input = new Float32Array([1, 1, 1, -1, -1, -1]);
    const output = new Int16Array(downsampleToPcm16(input, 48_000, 16_000));

    expect([...output]).toEqual([32767, -32768]);
  });

  it("clamps samples outside the valid audio range", () => {
    const output = new Int16Array(
      downsampleToPcm16(new Float32Array([2, -2]), 16_000, 16_000),
    );

    expect([...output]).toEqual([32767, -32768]);
  });
});
