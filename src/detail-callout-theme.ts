import { visibleWidth } from "@earendil-works/pi-tui";

export interface DetailCalloutStyle {
  foreground: string;
  background: string;
  accent: string;
  glyph: string;
}

export interface DetailCalloutTheme {
  readonly types: Readonly<Record<string, DetailCalloutStyle>>;
  readonly fallback: DetailCalloutStyle;
}

export interface DetailCalloutThemeResolution {
  theme: DetailCalloutTheme;
  errors: string[];
}

type DetailCalloutStyleOverride = Partial<DetailCalloutStyle>;

const BLUE: Omit<DetailCalloutStyle, "glyph"> = {
  foreground: "#D7E8F8",
  background: "#162637",
  accent: "#6CB6FF",
};
const GREEN: Omit<DetailCalloutStyle, "glyph"> = {
  foreground: "#DCF6E8",
  background: "#173026",
  accent: "#7AD9A5",
};
const VIOLET: Omit<DetailCalloutStyle, "glyph"> = {
  foreground: "#EFE5FF",
  background: "#282139",
  accent: "#C099FF",
};
const AMBER: Omit<DetailCalloutStyle, "glyph"> = {
  foreground: "#FFF0C7",
  background: "#392E18",
  accent: "#EBCB8B",
};
const CORAL: Omit<DetailCalloutStyle, "glyph"> = {
  foreground: "#FFE0E3",
  background: "#3A2025",
  accent: "#F27D7D",
};
const NEUTRAL: Omit<DetailCalloutStyle, "glyph"> = {
  foreground: "#D9E0E7",
  background: "#20262D",
  accent: "#AAB7C4",
};

export const DEFAULT_DETAIL_CALLOUT_THEME: DetailCalloutTheme = {
  types: {
    abstract: { ...BLUE, glyph: "≡" },
    note: { ...BLUE, glyph: "●" },
    info: { ...BLUE, glyph: "i" },
    todo: { ...BLUE, glyph: "□" },
    tip: { ...GREEN, glyph: "◆" },
    success: { ...GREEN, glyph: "✓" },
    question: { ...VIOLET, glyph: "?" },
    warning: { ...AMBER, glyph: "!" },
    failure: { ...CORAL, glyph: "×" },
    danger: { ...CORAL, glyph: "△" },
    bug: { ...CORAL, glyph: "※" },
    example: { ...VIOLET, glyph: "◇" },
    quote: { ...NEUTRAL, glyph: "❯" },
  },
  fallback: { ...NEUTRAL, glyph: "●" },
};

const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const STYLE_FIELDS = new Set<keyof DetailCalloutStyle>([
  "foreground",
  "background",
  "accent",
  "glyph",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validGlyph(value: unknown): value is string {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value) &&
    visibleWidth(value) === 1;
}

function resolveStyleOverride(
  name: string,
  base: DetailCalloutStyle,
  value: unknown,
  errors: string[],
): DetailCalloutStyle {
  if (!isRecord(value)) {
    errors.push(`${name} must be an object`);
    return base;
  }

  const override: DetailCalloutStyleOverride = {};
  for (const [field, candidate] of Object.entries(value)) {
    if (!STYLE_FIELDS.has(field as keyof DetailCalloutStyle)) {
      errors.push(`${name}.${field} is not supported`);
      continue;
    }
    if (field === "glyph") {
      if (validGlyph(candidate)) override.glyph = candidate;
      else errors.push(`${name}.glyph must be printable and exactly one terminal column`);
      continue;
    }
    if (typeof candidate === "string" && COLOR_PATTERN.test(candidate)) {
      override[field as "foreground" | "background" | "accent"] = candidate.toUpperCase();
    } else {
      errors.push(`${name}.${field} must be a #RRGGBB color`);
    }
  }
  return { ...base, ...override };
}

export function resolveDetailCalloutTheme(overrides: unknown): DetailCalloutThemeResolution {
  if (overrides === undefined) {
    return { theme: DEFAULT_DETAIL_CALLOUT_THEME, errors: [] };
  }
  if (!isRecord(overrides)) {
    return {
      theme: DEFAULT_DETAIL_CALLOUT_THEME,
      errors: ["callout theme must be an object"],
    };
  }

  const errors: string[] = [];
  const types: Record<string, DetailCalloutStyle> = {
    ...DEFAULT_DETAIL_CALLOUT_THEME.types,
  };
  let fallback = DEFAULT_DETAIL_CALLOUT_THEME.fallback;
  for (const [name, value] of Object.entries(overrides)) {
    if (name === "fallback") {
      fallback = resolveStyleOverride(name, fallback, value, errors);
      continue;
    }
    const base = types[name];
    if (!base) {
      errors.push(`${name} is not a canonical callout type`);
      continue;
    }
    types[name] = resolveStyleOverride(name, base, value, errors);
  }
  return { theme: { types, fallback }, errors };
}

export function detailCalloutThemeFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): DetailCalloutThemeResolution {
  const encoded = env.OUTLINER_CALLOUT_THEME?.trim();
  if (!encoded) return { theme: DEFAULT_DETAIL_CALLOUT_THEME, errors: [] };
  try {
    return resolveDetailCalloutTheme(JSON.parse(encoded));
  } catch {
    return {
      theme: DEFAULT_DETAIL_CALLOUT_THEME,
      errors: ["OUTLINER_CALLOUT_THEME must be valid JSON"],
    };
  }
}

export function detailCalloutStyle(
  theme: DetailCalloutTheme,
  canonicalType: string,
): DetailCalloutStyle {
  return theme.types[canonicalType] ?? theme.fallback;
}
