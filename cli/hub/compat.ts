// The Crit and Plannotator versions whose registry formats the hub was checked against.
export const VERIFIED_TOOL_VERSIONS = { crit: '0.19.0', plannotator: '0.27.8' } as const;

type Tool = keyof typeof VERIFIED_TOOL_VERSIONS;
export interface ToolCompatibility {
  installed: string | null;
  verifiedAgainst: string;
  status: 'verified' | 'unverified' | 'unavailable';
}

/** From each tool's `--version` output (null: not installed). */
export function assessCompatibility(versions: Record<string, string | null>): Record<Tool, ToolCompatibility> {
  const entries = Object.entries(VERIFIED_TOOL_VERSIONS).map(([tool, verifiedAgainst]) => {
    const installed = versions[tool]?.match(/\b(\d+\.\d+\.\d+)\b/)?.[1] ?? null;
    return [tool, { installed, verifiedAgainst, status: installed === null ? 'unavailable' : installed === verifiedAgainst ? 'verified' : 'unverified' }];
  });
  return Object.fromEntries(entries);
}
