import { beforeEach, describe, expect, it } from "vitest";
import {
  derivePublicHealthStatus,
  getPublicHealthSnapshot,
  observePublicModelTraffic,
  resetPublicHealthForTests,
  transitionPublicHealthComponent,
} from "./public-health";

describe("public health contract", () => {
  beforeEach(() => resetPublicHealthForTests());

  it("requires two consecutive failures before declaring an outage", () => {
    const first = transitionPublicHealthComponent(
      { status: "operational", failures: 0, checkedAt: 1 },
      false,
      2
    );
    const second = transitionPublicHealthComponent(first, false, 3);
    const recovered = transitionPublicHealthComponent(second, true, 4);

    expect(first.status).toBe("degraded");
    expect(second.status).toBe("outage");
    expect(recovered).toEqual({
      status: "operational",
      failures: 0,
      checkedAt: 4,
    });
  });

  it("derives the strongest status without hiding unknown coverage", () => {
    expect(
      derivePublicHealthStatus([
        { key: "application", status: "operational" },
        { key: "runtime", status: "operational" },
        { key: "model", status: "unknown" },
      ])
    ).toBe("unknown");
    expect(
      derivePublicHealthStatus([
        { key: "application", status: "operational" },
        { key: "runtime", status: "degraded" },
        { key: "model", status: "unknown" },
      ])
    ).toBe("degraded");
    expect(
      derivePublicHealthStatus([
        { key: "application", status: "outage" },
        { key: "runtime", status: "degraded" },
        { key: "model", status: "operational" },
      ])
    ).toBe("outage");
  });

  it("uses successful real traffic as model evidence", () => {
    observePublicModelTraffic("error", 1_000);
    expect(
      getPublicHealthSnapshot(1_100).components.find(
        item => item.key === "model"
      )?.status
    ).toBe("unknown");

    observePublicModelTraffic("success", 2_000);
    const snapshot = getPublicHealthSnapshot(2_100);
    expect(snapshot.profile).toBe("jiuwenswarm-agent");
    expect(snapshot.components.find(item => item.key === "model")?.status).toBe(
      "operational"
    );
  });
});
