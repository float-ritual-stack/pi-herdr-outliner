const WORK_ID_PREFIX_PATTERN = /^[A-Z][A-Z0-9]{0,15}$/;
const WORK_ID_PATTERN = /^([A-Za-z][A-Za-z0-9]{0,15})-(\d+)$/;

export interface ParsedWorkId {
  workId: string;
  prefix: string;
  number: number;
}

export interface WorkIdReference {
  workId: string;
  start: number;
  end: number;
}

export function normalizeWorkIdPrefix(input: string): string {
  const prefix = input.trim().toUpperCase();
  if (!WORK_ID_PREFIX_PATTERN.test(prefix)) {
    throw new Error("Work-ID prefix must contain 1-16 ASCII letters or digits and begin with a letter");
  }
  return prefix;
}


export function formatWorkId(prefix: string, number: number): string {
  const normalizedPrefix = normalizeWorkIdPrefix(prefix);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error("Work-ID number must be a positive safe integer");
  }
  return `${normalizedPrefix}-${String(number).padStart(3, "0")}`;
}

export function parseWorkId(input: string): ParsedWorkId | null {
  const match = WORK_ID_PATTERN.exec(input.trim());
  if (!match) return null;
  const number = Number(match[2]);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  const prefix = normalizeWorkIdPrefix(match[1]);
  return { workId: formatWorkId(prefix, number), prefix, number };
}

export function isCanonicalWorkId(input: string): boolean {
  const parsed = parseWorkId(input);
  return parsed !== null && parsed.workId === input.trim();
}

export function workIdReferences(
  text: string,
  configuredPrefix: string,
): WorkIdReference[] {
  const prefix = normalizeWorkIdPrefix(configuredPrefix);
  const pattern = new RegExp(
    `(?<![A-Za-z0-9-])${prefix}-\\d{3,}(?![A-Za-z0-9-])`,
    "g",
  );
  return [...text.matchAll(pattern)].flatMap((match) =>
    isCanonicalWorkId(match[0])
      ? [{
          workId: match[0],
          start: match.index,
          end: match.index + match[0].length,
        }]
      : []
  );
}
