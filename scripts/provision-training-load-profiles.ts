import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import { appRouter } from "../server/routers";
import { closeDbConnection } from "../server/db/connection";
import {
  createRegistration,
  createUser,
  getRegistrationByEmail,
  getUserByEmail,
} from "../server/db/users";
import { listClawsByUserId } from "../server/db/claw";
import { sdk, sessionAuthVersion } from "../server/_core/sdk";
import { COOKIE_NAME } from "../shared/const";
import type { TrpcContext } from "../server/_core/context";

type Options = {
  apply: boolean;
  count: number;
  concurrency: number;
  batch: string;
  output: string;
  roleTemplate: "general-assistant" | "insurance-advisor";
  selectedSkillId: string;
};

function parseOptions(argv: string[]): Options {
  const value = (name: string) => argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) || "";
  const count = Number(value("count") || 150);
  const concurrency = Number(value("concurrency") || 3);
  const roleTemplate = String(value("role") || "insurance-advisor") as Options["roleTemplate"];
  if (!["general-assistant", "insurance-advisor"].includes(roleTemplate)) {
    throw new Error("--role must be general-assistant or insurance-advisor");
  }
  const selectedSkillId = String(value("selected-skill") || (roleTemplate === "insurance-advisor" ? "auto-insurance-advisor" : "")).trim();
  const batch = String(value("batch") || `insurance-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}`)
    .toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").slice(0, 40);
  if (!Number.isInteger(count) || count < 1 || count > 200) throw new Error("--count must be an integer between 1 and 200");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10) throw new Error("--concurrency must be an integer between 1 and 10");
  if (!batch) throw new Error("--batch must contain letters or numbers");
  const output = path.resolve(value("output") || `data/load-tests/profiles-${batch}.json`);
  return { apply: argv.includes("--apply"), count, concurrency, batch, output, roleTemplate, selectedSkillId };
}

function assertLocalProvisioningAllowed(options: Options): void {
  if (!options.apply || process.env.EA_LOAD_TEST_ALLOW_LOCAL_PROVISION !== "1") {
    throw new Error("Refusing to provision. Add --apply and EA_LOAD_TEST_ALLOW_LOCAL_PROVISION=1 for an intentional local run.");
  }
  const publicUrl = new URL(process.env.WORKFORCE_AGENT_PUBLIC_BASE_URL || process.env.PUBLIC_BASE_URL || "http://127.0.0.1:5180");
  const allowedHosts = new Set(
    String(process.env.EA_LOAD_TEST_ALLOWED_HOSTS || "127.0.0.1,localhost,work.linggan.top")
      .split(",").map((item) => item.trim()).filter(Boolean),
  );
  if (!allowedHosts.has(publicUrl.hostname)) {
    throw new Error(`Refusing to provision against ${publicUrl.hostname}; configure EA_LOAD_TEST_ALLOWED_HOSTS explicitly.`);
  }
}

function callerContext(user: NonNullable<TrpcContext["user"]>): TrpcContext {
  return {
    user,
    req: {
      protocol: "https",
      method: "POST",
      originalUrl: "/api/trpc/claw.adopt",
      path: "/api/trpc/claw.adopt",
      headers: { host: "work.linggan.top", "user-agent": "ea-local-training-provisioner/1" },
      ip: "127.0.0.1",
      socket: { remoteAddress: "127.0.0.1" },
      get(name: string) { return this.headers[String(name).toLowerCase() as keyof typeof this.headers]; },
    } as unknown as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

async function runBounded<T>(count: number, concurrency: number, worker: (index: number) => Promise<T>): Promise<T[]> {
  const results = new Array<T>(count);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(count, concurrency) }, async () => {
    while (true) {
      const index = next++;
      if (index >= count) return;
      results[index] = await worker(index);
    }
  }));
  return results;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  assertLocalProvisioningAllowed(options);
  const passwordHash = await bcrypt.hash(`ea-load-${options.batch}-${Date.now()}`, 10);
  let createdUsers = 0;
  let createdAdoptions = 0;

  const profiles = await runBounded(options.count, options.concurrency, async (index) => {
    const ordinal = String(index + 1).padStart(3, "0");
    const email = `loadtest-${options.batch}-${ordinal}@training.linggan.local`;
    let user = await getUserByEmail(email);
    if (!user) {
      const userId = await createUser({
      name: `${options.roleTemplate === "insurance-advisor" ? "保险培训" : "通用基线"}用户 ${ordinal}`,
        email,
        password: passwordHash,
        loginMethod: "email",
        role: "user",
        accessLevel: "all",
        organization: `EA Local Load Test ${options.batch}`,
      });
      createdUsers += 1;
      user = await getUserByEmail(email);
      if (!user || user.id !== userId) throw new Error(`Failed to reload created user ${email}`);
    }
    if (user.accessLevel !== "all") throw new Error(`Existing load-test user ${email} does not have internal access`);

    if (!await getRegistrationByEmail(email)) {
      await createRegistration({
        name: user.name || `${options.roleTemplate === "insurance-advisor" ? "保险培训" : "通用基线"}用户 ${ordinal}`,
        company: `EA Local Load Test ${options.batch}`,
        partnerType: "financial_institution",
        email,
      });
    }

    const existing = (await listClawsByUserId(user.id)).find((item) => item.status === "active");
    if (existing && existing.roleTemplate !== options.roleTemplate) {
      throw new Error(`Existing user ${email} owns a ${existing.roleTemplate} adoption ${existing.adoptId}`);
    }
    const caller = appRouter.createCaller(callerContext(user));
    const adopted = await caller.claw.adopt({
      permissionProfile: "plus",
      roleTemplate: options.roleTemplate,
      preferRuntime: "jiuwenswarm",
    });
    if (!adopted.success || !adopted.adoption) throw new Error(`Failed to provision insurance adoption for ${email}`);
    if (!adopted.reused) createdAdoptions += 1;
    if (String(adopted.adoption.roleTemplate) !== options.roleTemplate) {
      throw new Error(`Provisioned adoption ${adopted.adoption.adoptId} has the wrong role`);
    }
    const token = await sdk.signSession({
      userId: user.id,
      name: user.name || email,
      authVersion: sessionAuthVersion(user),
    });
    process.stdout.write(`\rprovisioned ${index + 1}/${options.count}`);
    return {
      adoptId: String(adopted.adoption.adoptId),
      cookie: `${COOKIE_NAME}=${token}`,
      ...(options.selectedSkillId ? { selectedSkillId: options.selectedSkillId } : {}),
    };
  });

  mkdirSync(path.dirname(options.output), { recursive: true });
  writeFileSync(options.output, `${JSON.stringify(profiles, null, 2)}\n`, { mode: 0o600 });
  console.log(`\nprofiles=${options.output}`);
  console.log(`batch=${options.batch} role=${options.roleTemplate} total=${profiles.length} usersCreated=${createdUsers} adoptionsCreated=${createdAdoptions}`);
  console.log("Credentials are intentionally stored only as signed session cookies in the mode-0600 profile file.");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbConnection();
  });
