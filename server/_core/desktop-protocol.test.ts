import { describe, expect, it } from "vitest";
import {
  EA_DESKTOP_FEATURES,
  EA_DESKTOP_PROTOCOL,
  desktopProtocolMetadata,
  resolveDesktopRuntimeType,
} from "./desktop-protocol";

describe("desktop protocol metadata", () => {
  it("publishes a backwards-compatible v2 contract", () => {
    expect(EA_DESKTOP_PROTOCOL).toEqual({
      name: "ea.desktop",
      version: 2,
      minVersion: 1,
    });
  });

  it("identifies active JiuwenSwarm and archived runtimes", () => {
    expect(resolveDesktopRuntimeType("lgj-demo")).toBe("jiuwenswarm");
    expect(resolveDesktopRuntimeType("jiuwen_lgj-demo")).toBe("jiuwenswarm");
    expect(resolveDesktopRuntimeType("lgh-demo")).toBe("legacy_archived");
    expect(resolveDesktopRuntimeType("lgc-demo")).toBe("legacy_archived");
    expect(resolveDesktopRuntimeType(null)).toBe("unknown");
  });

  it("does not advertise unfinished desktop management features", () => {
    const metadata = desktopProtocolMetadata("lgj-demo");
    expect(metadata.runtime.type).toBe("jiuwenswarm");
    expect(metadata.features.chatStreaming).toBe(true);
    expect(metadata.features.connectorManagement).toBe(false);
    expect(metadata.features.experts).toBe(false);
    expect(metadata.features.localBridge).toBe(false);
    expect(metadata.features).toBe(EA_DESKTOP_FEATURES);
  });
});
