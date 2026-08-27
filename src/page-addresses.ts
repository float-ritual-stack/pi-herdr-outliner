import { parseWorkId } from "./work-ids";

const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const PAGE_ADDRESS_PATTERN = /\[\[([^\]\r\n]+)\]\]/g;

export const PAGE_ADDRESS_MAX_LENGTH = 512;
export const PAGE_ADDRESS_REGISTRY_VERSION = 1;

export interface NormalizedPageAddress {
  displayAddress: string;
  normalizedAddress: string;
}

export interface PageAddressReference extends NormalizedPageAddress {
  start: number;
  end: number;
}
export function isWorkIdAddress(address: string): boolean {
  return parseWorkId(address) !== null;
}

export function normalizePageAddress(input: string): NormalizedPageAddress {
  const displayAddress = input.trim();
  if (!displayAddress) throw new Error("Page address cannot be empty");
  if (displayAddress.length > PAGE_ADDRESS_MAX_LENGTH) {
    throw new Error(`Page address cannot exceed ${PAGE_ADDRESS_MAX_LENGTH} characters`);
  }
  if (CONTROL_PATTERN.test(displayAddress)) {
    throw new Error("Page address contains control characters");
  }
  if (displayAddress.includes("]")) {
    throw new Error("Page address cannot contain ]");
  }
  // Upper-then-lower performs stable caseless canonicalization for forms such as ß and final sigma.
  const normalizedAddress = displayAddress
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .toUpperCase()
    .toLowerCase();
  return { displayAddress, normalizedAddress };
}

export function tryNormalizePageAddress(input: string): NormalizedPageAddress | null {
  try {
    return normalizePageAddress(input);
  } catch {
    return null;
  }
}

export function pageAddressReferences(text: string): PageAddressReference[] {
  const references: PageAddressReference[] = [];
  for (const match of text.matchAll(PAGE_ADDRESS_PATTERN)) {
    try {
      references.push({
        ...normalizePageAddress(match[1]),
        start: match.index,
        end: match.index + match[0].length,
      });
    } catch {
      // Invalid authored syntax stays visible but is not actionable.
    }
  }
  return references;
}
