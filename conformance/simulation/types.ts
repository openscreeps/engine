import type { RoomStats, TickResult } from '../../src/simulation/index.ts';
import type {
  MoneyLogDoc,
  ResourceLogDoc,
  UserDoc,
  WorldState,
} from '../../src/simulation/state.ts';
import type { storeIntents } from '../../src/utils/system.ts';

export type RawIntents = Parameters<typeof storeIntents>[0];
export type UserIntents = Record<string, RawIntents>;
export type ProcessingOrder = Record<string, string[]>;
export type LocalIdOf = (oracleId: string) => string | undefined;
export type ObservedWorld = Omit<
  WorldState,
  | 'shardName'
  | 'restrictedShard'
  | 'terrain'
  | 'idCounter'
  | 'roomObjectWriteSeq'
  | 'writeSeq'
  | 'users'
  | 'usersMoney'
  | 'usersResources'
> & {
  users: Record<string, UserDoc & { 'resources.pixel'?: number }>;
  usersMoney: Record<string, Omit<MoneyLogDoc, 'date'> & { date: number | string }>;
  usersResources: Record<string, Omit<ResourceLogDoc, 'date'> & { date: number | string }>;
};
export interface TickRecord {
  gameTime: number;
  savedUsers: string[];
  processedRooms: string[];
  objectOrder: ProcessingOrder;
  roomStats: RoomStats;
  history: TickResult['history'];
  roomErrors: Array<{ room: string; message: string }>;
  loopErrors: string[];
  world: ObservedWorld;
}
export type CoverageCheck = (ticks: TickRecord[]) => unknown;
export interface Difference {
  path: string;
  oracle: unknown;
  local: unknown;
}
export interface TimedDifference extends Difference {
  gameTime: number;
}
export interface Divergence {
  name: string;
  kind: string;
  reason: string;
  paths: RegExp[];
  accept?: (difference: Difference) => boolean;
  oracle?: CoverageCheck;
  local?: CoverageCheck;
}
export interface Scenario {
  name: string;
  description: string;
  coverage: string[];
  clock: { start: number; step: number };
  world: WorldState;
  ticks: Array<{ intents?: UserIntents }>;
  checks?: Record<string, CoverageCheck>;
  divergences?: Divergence[];
  restartLocalBefore?: number[];
}
export interface OracleResult {
  type?: 'result';
  error?: string;
  ticks: TickRecord[];
  logs?: Array<{ level?: string; text: string }>;
}
export interface OracleRequest {
  type: 'run';
  referenceRoot: string;
  scenario: Omit<Scenario, 'world'> & {
    world: Pick<WorldState, 'gameTime' | 'rngState' | 'rooms' | 'terrain' | 'activeRooms'> &
      Partial<WorldState>;
  };
}
export interface Options {
  only: string[] | null;
  full: boolean;
  controlledOrder: boolean;
  allowKnownDivergences: boolean;
}
