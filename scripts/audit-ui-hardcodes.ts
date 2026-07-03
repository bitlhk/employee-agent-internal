#!/usr/bin/env tsx
/**
 * audit-ui-hardcodes.ts
 *
 * Read-only UI debt scanner for Workforce Agent Platform frontend pages.
 *
 * It intentionally reports likely risks instead of enforcing failures:
 * - hard-coded hex/rgb colors
 * - Tailwind color utilities that do not adapt to theme tokens
 * - inline style color/background/border/shadow risks
 *
 * Usage:
 *   pnpm tsx scripts/audit-ui-hardcodes.ts
 *   pnpm tsx scripts/audit-ui-hardcodes.ts client/src/components/pages/SchedulePageV2.tsx
 *   pnpm tsx scripts/audit-ui-hardcodes.ts --json
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

type FindingKind =
  | "hex"
  | "rgb"
  | "tw-hardcode"
  | "tw-status"
  | "inline-risk"
  | "nav-emoji";

type Finding = {
  file: string;
  line: number;
  kind: FindingKind;
  match: string;
  text: string;
};

type FileReport = {
  file: string;
  counts: Record<FindingKind, number>;
  findings: Finding[];
};

const DEFAULT_FILES = [
  "client/src/components/pages/SchedulePageV2.tsx",
  "client/src/components/pages/SettingsPage.tsx",
  "client/src/components/CollabDrawer.tsx",
];

const KIND_ORDER: FindingKind[] = [
  "hex",
  "rgb",
  "tw-hardcode",
  "tw-status",
  "inline-risk",
  "nav-emoji",
];

const HEX_RE = /#[0-9a-fA-F]{3,8}\b/g;
const RGB_RE = /\brgba?\s*\(/g;

// Theme-hostile Tailwind utilities. These tend to encode light/dark decisions
// directly in page code instead of using semantic tokens/components.
const TW_HARDCODE_RE =
  /\b(?:bg|text|border|ring|from|to|via|placeholder|divide|outline)-(?:white|black|slate|gray|zinc|neutral|stone)-(?:50|100|200|300|400|500|600|700|800|900|950)?\b|\b(?:bg|text|border|ring|from|to|via|placeholder|divide|outline)-(?:white|black)\b/g;

// Status utilities are not always wrong, but business state should usually go
// through StatusPill/status tokens instead of ad-hoc colors per page.
const TW_STATUS_RE =
  /\b(?:bg|text|border|ring|from|to|via|placeholder|divide|outline)-(?:red|green|yellow|orange|amber|blue|sky|cyan|teal|emerald|rose|pink|purple|violet|indigo)-(?:50|100|200|300|400|500|600|700|800|900|950)\b/g;

const INLINE_RISK_RE =
  /\b(?:background(?:Color)?|color|border(?:Color)?|boxShadow|shadow|outlineColor)\s*:\s*["'`{]/g;

// Functional navigation should use lucide icons, not emoji. Keep this scoped to
// likely navigation/tab declarations so user-generated chat content is ignored.
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}]/gu;
const NAV_CONTEXT_RE = /\b(?:SECTIONS|nav|tab|tabs|section|emoji|icon)\b/i;

function emptyCounts(): Record<FindingKind, number> {
  return {
    "hex": 0,
    "rgb": 0,
    "tw-hardcode": 0,
    "tw-status": 0,
    "inline-risk": 0,
    "nav-emoji": 0,
  };
}

function collectMatches(
  findings: Finding[],
  file: string,
  lineNo: number,
  text: string,
  kind: FindingKind,
  regex: RegExp,
) {
  regex.lastIndex = 0;
  for (const match of text.matchAll(regex)) {
    findings.push({
      file,
      line: lineNo,
      kind,
      match: match[0],
      text: text.trim().slice(0, 180),
    });
  }
}

function auditFile(file: string): FileReport {
  const abs = path.resolve(process.cwd(), file);
  if (!existsSync(abs)) {
    throw new Error(`File not found: ${file}`);
  }

  const findings: Finding[] = [];
  const lines = readFileSync(abs, "utf8").split(/\r?\n/);

  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    collectMatches(findings, file, lineNo, line, "hex", HEX_RE);
    collectMatches(findings, file, lineNo, line, "rgb", RGB_RE);
    collectMatches(findings, file, lineNo, line, "tw-hardcode", TW_HARDCODE_RE);
    collectMatches(findings, file, lineNo, line, "tw-status", TW_STATUS_RE);
    collectMatches(findings, file, lineNo, line, "inline-risk", INLINE_RISK_RE);
    if (NAV_CONTEXT_RE.test(line)) {
      collectMatches(findings, file, lineNo, line, "nav-emoji", EMOJI_RE);
    }
  });

  const counts = emptyCounts();
  for (const finding of findings) counts[finding.kind] += 1;
  return { file, counts, findings };
}

function pad(value: string | number, len: number): string {
  const s = String(value);
  return s.length >= len ? s : s + " ".repeat(len - s.length);
}

function printSummary(reports: FileReport[]) {
  const header = [
    pad("file", 58),
    pad("hex", 5),
    pad("rgb", 5),
    pad("tw-hardcode", 13),
    pad("tw-status", 10),
    pad("inline-risk", 12),
    pad("nav-emoji", 10),
  ].join(" ");
  console.log(header);
  console.log("-".repeat(header.length));

  for (const r of reports) {
    console.log([
      pad(r.file, 58),
      pad(r.counts.hex, 5),
      pad(r.counts.rgb, 5),
      pad(r.counts["tw-hardcode"], 13),
      pad(r.counts["tw-status"], 10),
      pad(r.counts["inline-risk"], 12),
      pad(r.counts["nav-emoji"], 10),
    ].join(" "));
  }
}

function printTopFindings(reports: FileReport[], topN: number) {
  for (const report of reports) {
    console.log("");
    console.log(report.file);
    for (const kind of KIND_ORDER) {
      const rows = report.findings.filter((f) => f.kind === kind);
      if (rows.length === 0) continue;
      console.log(`  ${kind} (${rows.length}):`);
      for (const f of rows.slice(0, topN)) {
        console.log(`    L${f.line}: ${f.match}  ${f.text}`);
      }
      if (rows.length > topN) console.log(`    ... (${rows.length - topN} more)`);
    }
  }
}

function printTotals(reports: FileReport[]) {
  const totals = emptyCounts();
  for (const r of reports) {
    for (const kind of KIND_ORDER) totals[kind] += r.counts[kind];
  }
  console.log("");
  console.log("Totals:");
  for (const kind of KIND_ORDER) {
    console.log(`  ${pad(kind, 12)} ${totals[kind]}`);
  }
}

function parseArgs(argv: string[]) {
  const json = argv.includes("--json");
  const topArg = argv.find((arg) => arg.startsWith("--top="));
  const topN = topArg ? Math.max(1, Number(topArg.slice("--top=".length)) || 8) : 8;
  const files = argv.filter((arg) => !arg.startsWith("--"));
  return { json, topN, files: files.length > 0 ? files : DEFAULT_FILES };
}

function main() {
  const { json, topN, files } = parseArgs(process.argv.slice(2));
  const reports = files.map(auditFile);

  if (json) {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), reports }, null, 2));
    return;
  }

  console.log("Workforce Agent Platform UI hardcode audit");
  console.log(`Generated: ${new Date().toISOString()}`);
  console.log("");
  printSummary(reports);
  printTotals(reports);
  printTopFindings(reports, topN);
}

main();
