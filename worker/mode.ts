export const SCAN_MODES = ["buy", "sell"] as const;

export type ScanMode = (typeof SCAN_MODES)[number];

export class ScanModeError extends Error {}

export function parseScanMode(value: unknown): ScanMode {
  if (value === null || value === undefined) return "buy";
  if (SCAN_MODES.includes(value as ScanMode)) return value as ScanMode;
  throw new ScanModeError("Invalid scan mode. Use buy or sell.");
}
