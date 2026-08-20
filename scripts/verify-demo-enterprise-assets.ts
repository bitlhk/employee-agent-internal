import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  discoverZipArtifacts,
  documentSeriesIdForPath,
  suggestEnterpriseAssetMetadata,
} from "../server/_core/enterprise-asset-discovery";

type GroundTruthAsset = {
  id: string;
  relativePath: string;
  format: string;
  role: string | null;
  domain: string;
  version: string | null;
  checksum: string;
  sizeBytes: number;
  duplicateOf?: string;
  series?: string;
  supersedes?: string;
  showcase?: boolean;
  expectedDiagnostics: string[];
  expectedLogicalAssetCandidates: string[];
};

type GroundTruthManifest = {
  schemaVersion: string;
  sourceId: string;
  ownerDepartment: string;
  assetCount: number;
  totalBytes: number;
  formatCounts: Record<string, number>;
  departmentCounts: Record<string, number>;
  assets: GroundTruthAsset[];
};

const APP_ROOT = process.cwd();
const GENERATED_ROOT = path.join(APP_ROOT, "examples", "demo-bank-enterprise-assets-v1", "generated");
const ASSET_ROOT = path.join(GENERATED_ROOT, "assets");
const ZIP_PATH = path.join(GENERATED_ROOT, "demo-bank-enterprise-assets-v1.zip");
const MANIFEST_PATH = path.join(GENERATED_ROOT, "ground-truth-manifest.json");
const MAX_DISCOVERY_BYTES = 50 * 1024 * 1024;

const roles = [
  { id: "general-assistant", name: "通用助手" },
  { id: "wealth-manager", name: "财富经理" },
  { id: "post-loan-risk-control", name: "风控经理" },
  { id: "insurance-advisor", name: "保险顾问" },
  { id: "credential-compliance", name: "智能审核" },
];

function checksum(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function equalValues(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function verify(): void {
  const failures: string[] = [];
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as GroundTruthManifest;
  if (manifest.schemaVersion !== "grace.demo-enterprise-assets/v1") failures.push(`manifest schema: ${manifest.schemaVersion}`);
  if (manifest.assetCount !== 60 || manifest.assets.length !== 60) failures.push(`asset count: ${manifest.assets.length}`);
  if (Object.keys(manifest.formatCounts).sort().join(",") !== "docx,md,pdf,pptx,xlsx") failures.push("required format coverage is incomplete");
  if (Object.keys(manifest.departmentCounts).length !== 4) failures.push("department coverage must contain four departments");
  if (manifest.totalBytes > MAX_DISCOVERY_BYTES) failures.push(`pack exceeds 50MB: ${manifest.totalBytes}`);
  if (statSync(ZIP_PATH).size > MAX_DISCOVERY_BYTES) failures.push(`zip exceeds 50MB: ${statSync(ZIP_PATH).size}`);

  const zipArtifacts = discoverZipArtifacts(readFileSync(ZIP_PATH));
  if (zipArtifacts.length !== manifest.assets.length) failures.push(`zip discovery count: ${zipArtifacts.length}`);
  const artifactByPath = new Map(zipArtifacts.map(artifact => [artifact.relativePath, artifact]));
  const truthById = new Map(manifest.assets.map(item => [item.id, item]));
  const firstPathByChecksum = new Map<string, string>();
  const seriesIds = new Map<string, Set<string>>();
  let remediationAssets = 0;
  let duplicateAssets = 0;
  let showcaseAssets = 0;

  for (const expected of manifest.assets) {
    const artifact = artifactByPath.get(expected.relativePath);
    if (!artifact) {
      failures.push(`${expected.relativePath}: missing from ZIP discovery`);
      continue;
    }
    const local = readFileSync(path.join(ASSET_ROOT, expected.relativePath));
    if (checksum(local) !== expected.checksum || artifact.checksum !== expected.checksum) failures.push(`${expected.relativePath}: checksum mismatch`);
    if (local.length !== expected.sizeBytes || artifact.sizeBytes !== expected.sizeBytes) failures.push(`${expected.relativePath}: size mismatch`);
    const result = suggestEnterpriseAssetMetadata({
      artifact,
      sourceId: manifest.sourceId,
      ownerDepartment: manifest.ownerDepartment,
      roles,
      externalProcessingAllowed: false,
    });
    const diagnostics = result.diagnostics.map(item => item.code);
    const firstDuplicate = firstPathByChecksum.get(artifact.checksum);
    if (firstDuplicate) diagnostics.push("DUPLICATE_CONTENT");
    else firstPathByChecksum.set(artifact.checksum, artifact.relativePath);
    diagnostics.sort();
    if (!equalValues(diagnostics, expected.expectedDiagnostics)) {
      failures.push(`${expected.relativePath}: diagnostics ${JSON.stringify(diagnostics)} != ${JSON.stringify(expected.expectedDiagnostics)}`);
    }
    if (!equalValues(result.metadata.applicableRoles, expected.role ? [expected.role] : [])) {
      failures.push(`${expected.relativePath}: role ${JSON.stringify(result.metadata.applicableRoles)} != ${expected.role || "unresolved"}`);
    }
    if (result.metadata.suggestedDomain !== expected.domain) failures.push(`${expected.relativePath}: domain ${result.metadata.suggestedDomain} != ${expected.domain}`);
    if (!equalValues(result.metadata.logicalAssetCandidates, expected.expectedLogicalAssetCandidates)) {
      failures.push(`${expected.relativePath}: logical asset suggestions differ`);
    }
    if (expected.version && result.sourceVersion !== expected.version) failures.push(`${expected.relativePath}: version ${result.sourceVersion} != ${expected.version}`);
    if (expected.duplicateOf) {
      duplicateAssets += 1;
      const original = truthById.get(expected.duplicateOf);
      if (!original || original.checksum !== expected.checksum) failures.push(`${expected.relativePath}: duplicate ground truth is inconsistent`);
    }
    if (expected.expectedDiagnostics.length) remediationAssets += 1;
    if (expected.showcase) showcaseAssets += 1;
    if (expected.series) {
      const values = seriesIds.get(expected.series) || new Set<string>();
      values.add(documentSeriesIdForPath(manifest.sourceId, expected.relativePath));
      seriesIds.set(expected.series, values);
      if (expected.supersedes && !truthById.has(expected.supersedes)) failures.push(`${expected.relativePath}: supersedes unknown asset ${expected.supersedes}`);
    }
  }

  for (const [series, ids] of seriesIds) {
    if (ids.size !== 1) failures.push(`${series}: deterministic document series split into ${ids.size} IDs`);
  }
  if (duplicateAssets < 1) failures.push("duplicate scenario is missing");
  if (remediationAssets < 10) failures.push(`remediation coverage too small: ${remediationAssets}`);
  if (showcaseAssets < 3) failures.push(`showcase version chains too small: ${showcaseAssets}`);

  const python = process.env.KNOWLEDGE_PYTHON || path.join(process.env.HOME || "/home/ubuntu", ".venvs", "employee-agent-knowledge", "bin", "python");
  let parserReport: { ok: boolean; parsed: number; failures: unknown[]; totalSegments: number; totalCharacters: number } | null = null;
  try {
    const output = execFileSync(python, [
      path.join(APP_ROOT, "scripts", "verify_demo_asset_parsing.py"),
      "--asset-root", ASSET_ROOT,
      "--manifest", MANIFEST_PATH,
    ], { encoding: "utf8" });
    parserReport = JSON.parse(output.trim());
    if (!parserReport.ok || parserReport.parsed !== manifest.assets.length) failures.push(`parser coverage: ${parserReport.parsed}/${manifest.assets.length}`);
  } catch (error) {
    failures.push(`knowledge parser verification failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const report = {
    status: failures.length ? "FAIL" : "PASS",
    assetCount: manifest.assets.length,
    totalBytes: manifest.totalBytes,
    zipBytes: statSync(ZIP_PATH).size,
    formats: manifest.formatCounts,
    departments: manifest.departmentCounts,
    remediationAssets,
    duplicateAssets,
    versionSeries: seriesIds.size,
    showcaseAssets,
    parser: parserReport,
    failures,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (failures.length) process.exitCode = 1;
}

verify();
