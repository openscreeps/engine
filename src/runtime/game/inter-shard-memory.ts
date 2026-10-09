/*
 * `InterShardMemory` (official game API; absent from the open-source private server). Every shard keeps
 * up to 100 KB of string data per player; other shards' data is read-only. The data itself is kept
 * by the embedding (`InterShardStore`) and delivered in `runtimeData.account`.
 */

import { jsString } from '../../utils/js.ts';
import { isString } from '../../utils/lodash.ts';
import { exposeGlobal } from './define.ts';
import { scope } from './scope.ts';

/** Maximum length of one shard's inter-shard data (official docs: 100 KB). */
export const INTER_SHARD_MEMORY_LIMIT = 100 * 1024;

export interface InterShardMemoryApi {
  getLocal(): string;
  setLocal(value: unknown): void;
  getRemote(shard: unknown): string | null;
}

let local = '';
let changed = false;

const interShardMemory: InterShardMemoryApi = {
  getLocal(): string {
    return local;
  },
  setLocal(value: unknown): void {
    if (!isString(value)) {
      throw new Error('InterShardMemory value is not a string');
    }
    const text = jsString(value);
    if (text.length > INTER_SHARD_MEMORY_LIMIT) {
      throw new Error('InterShardMemory size exceeded 100 KB limit');
    }
    local = text;
    changed = true;
  },
  getRemote(shard: unknown): string | null {
    const name = jsString(shard);
    const { account, shardName } = scope().runtimeData;
    if (name === shardName) {
      return local;
    }
    return Object.prototype.hasOwnProperty.call(account.interShardRemote, name)
      ? (account.interShardRemote[name] ?? null)
      : null;
  },
};

/** Per-tick reset; exposes the global on first use in this sandbox. */
export function make(): void {
  local = scope().runtimeData.account.interShardLocal;
  changed = false;
  if (!scope().globals.InterShardMemory) {
    exposeGlobal('InterShardMemory', interShardMemory);
  }
}

/** New local data written this tick, if any. */
export function takeLocalChange(): string | undefined {
  return changed ? local : undefined;
}
