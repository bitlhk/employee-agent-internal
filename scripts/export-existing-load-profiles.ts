import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { listClawAdoptionsAdmin } from "../server/db/claw";
import { closeDbConnection } from "../server/db/connection";
import { getUserById } from "../server/db/users";
import { sdk, sessionAuthVersion } from "../server/_core/sdk";
import { COOKIE_NAME } from "../shared/const";

type Options = {
  count: number;
  output: string;
  roles: Set<string>;
  adoptIds: Set<string>;
};

function optionValue(argv: string[], name: string): string {
  return argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) || "";
}

function parseOptions(argv: string[]): Options {
  if (!argv.includes("--export") || process.env.EA_LOAD_TEST_ALLOW_PROFILE_EXPORT !== "1") {
    throw new Error(
      "Refusing to export signed sessions. Add --export and EA_LOAD_TEST_ALLOW_PROFILE_EXPORT=1 intentionally.",
    );
  }
  const count = Number(optionValue(argv, "count") || 50);
  if (!Number.isInteger(count) || count < 1 || count > 150) {
    throw new Error("--count must be an integer between 1 and 150");
  }
  const output = path.resolve(
    optionValue(argv, "output") || `data/load-tests/profiles-existing-${Date.now()}.json`,
  );
  const roles = new Set(
    optionValue(argv, "roles").split(",").map((item) => item.trim()).filter(Boolean),
  );
  const adoptIds = new Set(
    optionValue(argv, "adopt-ids").split(",").map((item) => item.trim()).filter(Boolean),
  );
  return { count, output, roles, adoptIds };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const rows = await listClawAdoptionsAdmin({ status: "active", limit: 1000 });
  const eligible = rows.filter((row) => (
    String(row.adoptId).startsWith("lgj-")
    && String(row.runtime) === "jiuwenswarm"
    && (!options.roles.size || options.roles.has(String(row.roleTemplate)))
    && (!options.adoptIds.size || options.adoptIds.has(String(row.adoptId)))
  ));

  if (!eligible.length) throw new Error("No active JiuwenSwarm adoptions matched the export filters");
  const selected = eligible.slice(0, options.count);
  const profiles = [];
  for (const row of selected) {
    const user = await getUserById(Number(row.userId));
    if (!user) throw new Error(`User ${row.userId} for ${row.adoptId} no longer exists`);
    const token = await sdk.signSession({
      userId: user.id,
      name: user.name || user.email || String(row.adoptId),
      authVersion: sessionAuthVersion(user),
    });
    profiles.push({
      adoptId: String(row.adoptId),
      roleTemplate: String(row.roleTemplate),
      cookie: `${COOKIE_NAME}=${token}`,
    });
  }

  mkdirSync(path.dirname(options.output), { recursive: true });
  writeFileSync(options.output, `${JSON.stringify(profiles, null, 2)}\n`, { mode: 0o600 });
  console.log(`profiles=${options.output}`);
  console.log(`exported=${profiles.length} eligible=${eligible.length}`);
  console.log("The output contains signed sessions. Delete it immediately after the controlled load test.");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbConnection();
  });
