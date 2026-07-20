import { describe, expect, it } from "vitest";
import { buttonVariants } from "./button";

describe("buttonVariants", () => {
  it.each(["outline", "ghost"] as const)(
    "uses the neutral application hover surface for %s buttons",
    (variant) => {
      const classes = buttonVariants({ variant });

      expect(classes).toContain("hover:bg-[var(--oc-bg-hover)]");
      expect(classes).not.toContain("hover:bg-accent");
    },
  );
});
