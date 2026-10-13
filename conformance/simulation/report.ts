import type { TimedDifference } from './types.ts';

export interface NormalizationStats {
  pairedByRawId: number;
  pairedByContent: number;
  pairedBySimilarity: number;
  unpairedDocumentTicks: number;
}
export interface ScenarioReport {
  name: string;
  status: 'match' | 'mismatch' | 'divergent' | 'vacuous' | 'error';
  description: string;
  ticks: { planned: number; oracle: number; compared: number };
  coverage: string[];
  checks: { passed: number; failed: Array<{ name: string; oracle: boolean; local: boolean }> };
  processingOrder: {
    controlled: boolean;
    roomTicksDiffering: number;
    firstDiffering: {
      gameTime: number;
      room: string;
      oracle: string[] | undefined;
      local: string[] | undefined;
    } | null;
  };
  firstMismatchTick: number | null;
  differenceCount: number;
  differences: TimedDifference[];
  divergences: Array<{
    name: string;
    kind: string;
    reason: string;
    assertions: { oracle: boolean | string; local: boolean | string };
    differenceCount: number;
    differences: TimedDifference[];
  }>;
  normalization: NormalizationStats;
  oracleRoomErrors: Array<{ gameTime: number; room: string; message: string }>;
  localRoomErrors: Array<{ gameTime: number; room: string; message: string }>;
  oracleError?: string;
  oracleLogs?: string[];
}
