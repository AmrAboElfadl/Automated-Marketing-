/**
 * Minimal argument parsing shared by the operator scripts.
 * No dependency — the surface is small and adding one for this is not worth it.
 *
 * Supports:  --key value   --key=value   --flag
 */

export type Args = Map<string, string | true>;

export function parseArgs(argv: string[]): Args {
  const args: Args = new Map();

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;

    const body = token.slice(2);
    const eq = body.indexOf("=");

    if (eq !== -1) {
      args.set(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }

    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args.set(body, true); // bare flag
    } else {
      args.set(body, next);
      i++;
    }
  }

  return args;
}

export function fail(message: string): never {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

/** A required option that must carry a value, not just be present. */
export function required(args: Args, name: string): string {
  const value = args.get(name);
  if (value === undefined) fail(`--${name} is required`);
  if (value === true) fail(`--${name} needs a value`);
  return value;
}

export function optional(args: Args, name: string): string | undefined {
  const value = args.get(name);
  if (value === undefined || value === true) return undefined;
  return value;
}

export function flag(args: Args, name: string): boolean {
  return args.get(name) !== undefined;
}

export function integer(args: Args, name: string, fallback: number): number {
  const raw = optional(args, name);
  if (raw === undefined) return fallback;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    fail(`--${name} must be a non-negative whole number, got "${raw}"`);
  }
  return parsed;
}

/** Narrows a free-text option to one of the database enum's values. */
export function oneOf<T extends string>(
  args: Args,
  name: string,
  allowed: readonly T[],
  fallback?: T
): T {
  const raw = optional(args, name);
  if (raw === undefined) {
    if (fallback !== undefined) return fallback;
    fail(`--${name} is required, one of: ${allowed.join(", ")}`);
  }

  const match = allowed.find((value) => value === raw);
  if (!match) {
    fail(`--${name}="${raw}" is invalid. Use one of: ${allowed.join(", ")}`);
  }
  return match;
}

export function commaList(args: Args, name: string): string[] {
  const raw = optional(args, name);
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/** An ISO timestamp, defaulting to now. */
export function timestamp(args: Args, name: string): Date {
  const raw = optional(args, name);
  if (!raw) return new Date();

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    fail(`--${name}="${raw}" is not a valid date. Use ISO 8601, e.g. 2026-08-06T18:00:00Z`);
  }
  return parsed;
}

export function usage(lines: string[]): void {
  console.log(lines.join("\n"));
}
