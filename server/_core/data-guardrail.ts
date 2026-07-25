export type SensitiveDataType =
  | "private_key"
  | "credential"
  | "cn_id_card"
  | "cn_phone"
  | "bank_card";

export type DataGuardrailMode = "off" | "monitor" | "enforce";
export type DataGuardrailAction = "allow" | "redact" | "block";

export type SensitiveDataDetection = {
  type: SensitiveDataType;
  start: number;
  end: number;
};

export type DataGuardrailDecision = {
  action: DataGuardrailAction;
  text: string;
  detections: SensitiveDataDetection[];
  types: SensitiveDataType[];
  changed: boolean;
};

type DetectOptions = {
  requireBankCardContext?: boolean;
};

const TYPE_PRIORITY: Record<SensitiveDataType, number> = {
  private_key: 100,
  credential: 90,
  cn_id_card: 80,
  cn_phone: 70,
  bank_card: 60,
};

const REDACTION_LABELS: Record<SensitiveDataType, string> = {
  private_key: "[REDACTED_PRIVATE_KEY]",
  credential: "[REDACTED_CREDENTIAL]",
  cn_id_card: "[REDACTED_ID]",
  cn_phone: "[REDACTED_PHONE]",
  bank_card: "[REDACTED_BANK_CARD]",
};

const BANK_CARD_CONTEXT_RE =
  /(?:银行卡|银行卡号|卡号|借记卡|信用卡|结算卡|bank\s*card|card\s*(?:no|number)|account\s*(?:no|number))/i;
const BLOCKING_TYPES = new Set<SensitiveDataType>([
  "private_key",
  "credential",
]);

function collectMatches(
  text: string,
  pattern: RegExp,
  type: SensitiveDataType,
  detections: SensitiveDataDetection[],
  predicate?: (matched: string, start: number, end: number) => boolean
): void {
  for (const match of text.matchAll(pattern)) {
    const value = match[0];
    const start = match.index ?? -1;
    const end = start + value.length;
    if (start < 0 || !value || (predicate && !predicate(value, start, end)))
      continue;
    detections.push({ type, start, end });
  }
}

function isValidDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function isValidChineseIdCard(value: string): boolean {
  const normalized = String(value || "").toUpperCase();
  if (!/^\d{17}[0-9X]$/.test(normalized)) return false;
  const year = Number(normalized.slice(6, 10));
  const month = Number(normalized.slice(10, 12));
  const day = Number(normalized.slice(12, 14));
  if (!isValidDate(year, month, day)) return false;

  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checks = "10X98765432";
  const sum = normalized
    .slice(0, 17)
    .split("")
    .reduce((total, digit, index) => total + Number(digit) * weights[index], 0);
  return checks[sum % 11] === normalized[17];
}

export function isValidLuhnNumber(value: string): boolean {
  const digits = String(value || "").replace(/[^0-9]/g, "");
  if (!/^\d{16,19}$/.test(digits) || /^(\d)\1+$/.test(digits)) return false;
  let sum = 0;
  let doubleDigit = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

function removeOverlaps(
  detections: SensitiveDataDetection[]
): SensitiveDataDetection[] {
  const selected: SensitiveDataDetection[] = [];
  const prioritized = [...detections].sort(
    (left, right) =>
      TYPE_PRIORITY[right.type] - TYPE_PRIORITY[left.type] ||
      right.end - right.start - (left.end - left.start) ||
      left.start - right.start
  );
  for (const candidate of prioritized) {
    const overlaps = selected.some(
      existing =>
        candidate.start < existing.end && candidate.end > existing.start
    );
    if (!overlaps) selected.push(candidate);
  }
  return selected.sort((left, right) => left.start - right.start);
}

export function detectSensitiveData(
  value: unknown,
  options: DetectOptions = {}
): SensitiveDataDetection[] {
  const text = String(value || "");
  if (!text) return [];
  const detections: SensitiveDataDetection[] = [];

  collectMatches(
    text,
    /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/gi,
    "private_key",
    detections
  );
  collectMatches(
    text,
    /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/gi,
    "private_key",
    detections
  );
  collectMatches(
    text,
    /(?<![A-Za-z0-9_])(?:api[_ -]?key|access[_ -]?token|client[_ -]?secret|password|passwd|authorization|gateway[_ -]?token|bot[_ -]?token)["']?\s*[:=]\s*(?:"[^"\r\n]{6,}"|'[^'\r\n]{6,}'|(?:(?:Bearer|Basic)\s+)?[^\s,;]{6,})/gi,
    "credential",
    detections
  );
  collectMatches(
    text,
    /密码\s*[:=]\s*["']?[A-Za-z0-9!@#$%^&*()_+=[\]{}:;,.?~\/-]{6,}["']?/g,
    "credential",
    detections
  );
  collectMatches(
    text,
    /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}={0,2}\b/gi,
    "credential",
    detections
  );
  collectMatches(
    text,
    /\b(?:sk|ak)-[A-Za-z0-9_-]{16,}\b/gi,
    "credential",
    detections
  );
  collectMatches(text, /\bAKIA[A-Z0-9]{16}\b/g, "credential", detections);
  collectMatches(
    text,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    "credential",
    detections
  );

  collectMatches(
    text,
    /(?<!\d)\d{17}[0-9Xx](?!\d)/g,
    "cn_id_card",
    detections,
    matched => isValidChineseIdCard(matched)
  );
  collectMatches(
    text,
    /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/g,
    "cn_phone",
    detections
  );
  collectMatches(
    text,
    /(?<!\d)(?:\d[ -]?){15,18}\d(?!\d)/g,
    "bank_card",
    detections,
    (matched, start, end) => {
      if (!isValidLuhnNumber(matched)) return false;
      if (options.requireBankCardContext === false) return true;
      const context = text.slice(
        Math.max(0, start - 24),
        Math.min(text.length, end + 24)
      );
      return BANK_CARD_CONTEXT_RE.test(context);
    }
  );

  return removeOverlaps(detections);
}

export function redactSensitiveData(
  value: unknown,
  options: DetectOptions = {}
): DataGuardrailDecision {
  const original = String(value || "");
  const detections = detectSensitiveData(original, options);
  let text = original;
  for (const detection of [...detections].sort(
    (left, right) => right.start - left.start
  )) {
    text = `${text.slice(0, detection.start)}${REDACTION_LABELS[detection.type]}${text.slice(detection.end)}`;
  }
  return {
    action: detections.length ? "redact" : "allow",
    text,
    detections,
    types: [...new Set(detections.map(item => item.type))],
    changed: text !== original,
  };
}

export function dataGuardrailMode(
  raw = process.env.EA_DATA_GUARDRAIL_MODE
): DataGuardrailMode {
  const normalized = String(raw || "enforce")
    .trim()
    .toLowerCase();
  if (normalized === "off" || normalized === "monitor") return normalized;
  return "enforce";
}

export function protectExternalText(
  value: unknown,
  options: DetectOptions & { mode?: DataGuardrailMode } = {}
): DataGuardrailDecision {
  const original = String(value || "");
  const mode = options.mode || dataGuardrailMode();
  if (mode === "off") {
    return {
      action: "allow",
      text: original,
      detections: [],
      types: [],
      changed: false,
    };
  }
  const redacted = redactSensitiveData(original, options);
  if (!redacted.detections.length) return redacted;
  if (mode === "monitor")
    return { ...redacted, action: "allow", text: original, changed: false };
  return {
    ...redacted,
    action: redacted.types.some(type => BLOCKING_TYPES.has(type))
      ? "block"
      : "redact",
  };
}
