import { describe, expect, it } from "vitest";
import { serializedFileMutationCountForTests, withSerializedFileMutation } from "./serialized-file-mutation";

describe("withSerializedFileMutation", () => {
  it("serializes mutations for one file and releases the tail", async () => {
    const events: string[] = [];
    let releaseFirst = () => {};
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = withSerializedFileMutation("/tmp/registry.json", async () => {
      events.push("first:start");
      await gate;
      events.push("first:end");
    });
    const second = withSerializedFileMutation("/tmp/registry.json", async () => {
      events.push("second");
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second"]);
    expect(serializedFileMutationCountForTests()).toBe(0);
  });
});
