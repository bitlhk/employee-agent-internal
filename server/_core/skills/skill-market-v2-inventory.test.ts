import { describe, expect, it } from "vitest";
import type { Skill } from "../../../shared/types/skill";
import {
  buildSkillMarketV2Inventory,
  type LegacySkillMarketRow,
} from "./skill-market-v2-inventory";

const baseRow: LegacySkillMarketRow = {
  id: 1,
  skillId: "meeting-to-task",
  authorUserId: 7,
  version: "1.0.0",
  status: "approved",
  origin: "uploaded",
  author: "Demo Author",
  license: "MIT",
  packagePath: "/skill-store/marketplace/approved/meeting-to-task",
};

function report(
  overrides: Partial<Parameters<typeof buildSkillMarketV2Inventory>[0]> = {}
) {
  return buildSkillMarketV2Inventory({
    marketplaceRows: [baseRow],
    registrySkills: [],
    roleSkillGrants: [],
    maintainerMemberships: [
      { userId: 7, organizationId: "org-1", status: "active" },
    ],
    adoptions: [],
    artifacts: [
      {
        marketplaceRowId: 1,
        exists: true,
        insideSkillStore: true,
        sourceTreeSha256: "a".repeat(64),
        sourceSkillId: "meeting-to-task",
        validSource: true,
      },
    ],
    generatedAt: "2026-08-24T00:00:00.000Z",
    ...overrides,
  });
}

describe("skill market v2 inventory", () => {
  it("marks a complete legacy row as automatically mappable", () => {
    expect(report().summary).toMatchObject({
      autoMappableMarketplaceRows: 1,
      manualResolutionMarketplaceRows: 0,
      blockers: 0,
      warnings: 0,
    });
    expect(report().maintenanceDecisions).toEqual([
      expect.objectContaining({
        marketplaceRowId: 1,
        proposedMaintainerType: "user",
        proposedMaintainerUserId: 7,
        upstreamAuthor: "Demo Author",
      }),
    ]);
  });

  it("classifies a centrally imported row as system-maintained", () => {
    const result = report({
      marketplaceRows: [{ ...baseRow, authorUserId: null }],
      maintainerMemberships: [],
    });
    expect(result.summary).toMatchObject({
      proposedSystemMaintainedRows: 1,
      proposedUserMaintainedRows: 0,
      manualResolutionMarketplaceRows: 0,
    });
    expect(result.maintenanceDecisions[0]).toMatchObject({
      proposedMaintainerType: "system",
      proposedMaintainerUserId: null,
      basis: "centrally_imported",
    });
  });

  it("blocks duplicate versions and conflicting user maintainers for one immutable skillId", () => {
    const result = report({
      marketplaceRows: [baseRow, { ...baseRow, id: 2, authorUserId: 8 }],
      maintainerMemberships: [
        { userId: 7, organizationId: "org-1", status: "active" },
        { userId: 8, organizationId: "org-1", status: "active" },
      ],
      artifacts: [
        {
          marketplaceRowId: 1,
          exists: true,
          insideSkillStore: true,
          sourceTreeSha256: "a".repeat(64),
        },
        {
          marketplaceRowId: 2,
          exists: true,
          insideSkillStore: true,
          sourceTreeSha256: "b".repeat(64),
        },
      ],
    });
    expect(result.issues.map(issue => issue.code)).toEqual(
      expect.arrayContaining([
        "SKILL_ID_MAINTAINER_CONFLICT",
        "SKILL_VERSION_DUPLICATE",
      ])
    );
    expect(result.summary.manualResolutionMarketplaceRows).toBe(2);
  });

  it("reports broken installed marketplace references without changing runtime state", () => {
    const registrySkill = {
      id: "meeting-to-task",
      adoptId: "lgj-demo",
      source: {
        kind: "marketplace",
        skillId: "meeting-to-task",
        displayName: "Meeting to Task",
        marketplaceId: "999",
      },
      state: "ready",
      enabled: true,
      review: { state: "passed" },
      sync: {},
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:00.000Z",
    } satisfies Skill;
    const result = report({ registrySkills: [registrySkill] });
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "REGISTRY_MARKETPLACE_ROW_MISSING",
          adoptId: "lgj-demo",
        }),
      ])
    );
    expect(result.dryRun).toBe(true);
  });

  it("counts personal installations that overlap role preinstall defaults", () => {
    const registrySkill = {
      id: "meeting-to-task",
      adoptId: "lgj-demo",
      source: {
        kind: "marketplace",
        skillId: "meeting-to-task",
        displayName: "Meeting to Task",
        marketplaceId: "1",
      },
      state: "ready",
      enabled: true,
      review: { state: "passed" },
      sync: {},
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:00.000Z",
    } satisfies Skill;
    const result = report({
      registrySkills: [registrySkill],
      roleSkillGrants: [
        {
          roleKey: "wealth-manager",
          assetId: "meeting-to-task",
          grantMode: "default",
          source: "admin",
          enabled: true,
        },
      ],
      adoptions: [{ adoptId: "lgj-demo", roleTemplate: "wealth-manager" }],
    });
    expect(result.summary.roleDefaultRegistryOverlaps).toBe(1);
  });
});
