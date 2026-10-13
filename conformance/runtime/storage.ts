import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import type { WorldState } from '../../src/simulation/state.ts';
import type { OracleUserState } from './oracle.ts';

type Document = Record<string, unknown>;
interface Query {
  [key: string]: unknown;
}
export interface FixtureCommon {
  storage: {
    env: {
      keys: Record<
        | 'MEMORY'
        | 'MEMORY_SEGMENTS'
        | 'PUBLIC_MEMORY_SEGMENTS'
        | 'GAMETIME'
        | 'ROOM_EVENT_LOG'
        | 'TERRAIN_DATA',
        string
      >;
    };
    db: Record<string, unknown>;
    pubsub: { publish: (...args: unknown[]) => Promise<unknown> };
    _connect: () => Promise<unknown>;
  };
  configManager: {
    load: () => void;
    config: { common: { dbCollections: string[] } };
  };
}

// RPC/storage adapter, not gameplay implementation. Unsupported queries fail closed rather than
// inventing a result. Documents and ordering are exactly those supplied to the local WorldState.
function matches(document: Document, query: Query = {}): boolean {
  return Object.entries(query).every(([key, value]) => {
    if (key === '$and') return (value as Query[]).every((part) => matches(document, part));
    if (key === '$or') return (value as Query[]).some((part) => matches(document, part));
    const actual = document[key];
    if (value && typeof value === 'object') {
      return Object.entries(value).every(([operator, operand]) => {
        switch (operator) {
          case '$in':
            return (operand as unknown[]).includes(actual);
          case '$ne':
            return actual !== operand;
          case '$gt':
            return (actual as number) > (operand as number);
          default:
            throw new Error(`Unsupported oracle storage query ${operator}`);
        }
      });
    }
    return actual === value;
  });
}

/** Keep adapter operations promise-returning and turn synchronous query failures into rejections. */
function promised<T>(operation: () => T): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  try {
    resolve(operation());
  } catch (error) {
    reject(error);
  }
  return promise;
}

export function attachFixtureStorage(common: FixtureCommon) {
  const values = new Map<string, string>();
  const hashes = new Map<string, Record<string, string>>();
  const tables = new Map<string, Document[]>();
  const { env, db, pubsub } = common.storage;
  const clone = <T>(value: T): T => structuredClone(value);
  const table = (name: string): Document[] => {
    const documents = tables.get(name);
    assert.ok(documents, `Unknown fixture collection ${name}`);
    return documents;
  };
  Object.assign(env, {
    get: (key: string) => promised(() => values.get(key) ?? null),
    set: (key: string, value: string) => promised(() => values.set(key, value)),
    hmget: (key: string, fields: string[]) =>
      promised(() => fields.map((field) => hashes.get(key)?.[field] ?? null)),
    hget: (key: string, field: string) => promised(() => hashes.get(key)?.[field] ?? null),
    hmset: (key: string, data: Record<string, string>) =>
      promised(() => hashes.set(key, { ...hashes.get(key), ...clone(data) })),
  });
  pubsub.publish = async () => {};
  common.storage._connect = async () => {};
  common.configManager.load = () => {};
  for (const name of common.configManager.config.common.dbCollections) {
    tables.set(name, []);
    db[name] = {
      find: (query: Query) =>
        promised(() => clone(table(name).filter((document) => matches(document, query)))),
      findOne: (query: Query) =>
        promised(() => clone(table(name).find((document) => matches(document, query)) ?? null)),
      findEx: (query: Query, options?: { sort?: Record<string, number>; limit?: number }) =>
        promised(() => {
          let result = table(name).filter((document) => matches(document, query));
          for (const [key, direction] of Object.entries(options?.sort ?? {})) {
            result = [...result].sort(
              (a, b) => ((a[key] as number) - (b[key] as number)) * direction,
            );
          }
          return clone(result.slice(0, options?.limit ?? result.length));
        }),
      removeWhere: (query: Query) =>
        promised(() =>
          tables.set(
            name,
            table(name).filter((document) => !matches(document, query)),
          ),
        ),
      update: (query: Query, update: Record<string, Document>) =>
        promised(() => {
          for (const document of table(name).filter((entry) => matches(entry, query))) {
            for (const [operator, data] of Object.entries(update)) {
              assert.equal(
                operator,
                '$set',
                'Only data.js inactivity bookkeeping uses fixture DB updates',
              );
              Object.assign(document, clone(data));
            }
          }
        }),
    };
  }
  function sync(world: WorldState, users: Record<string, OracleUserState>) {
    const collections = {
      rooms: world.rooms,
      'rooms.objects': world.roomObjects,
      'rooms.flags': world.flags,
      users: world.users,
      'users.power_creeps': world.userPowerCreeps,
      'market.orders': world.marketOrders,
      'market.stats': world.marketStats,
      transactions: world.transactions,
    };
    for (const [name, documents] of Object.entries(collections))
      tables.set(name, clone(Object.values(documents)) as Document[]);
    tables.set('users.code', []);
    tables.set('users.console', []);
    for (const [id, state] of Object.entries(users)) {
      const document = table('users').find((user) => user._id === id);
      assert.ok(document, `Unknown fixture user ${id}`);
      document.activeSegments = clone(state.activeSegments);
      if (state.activeForeignSegment !== undefined)
        document.activeForeignSegment = clone(state.activeForeignSegment);
      table('users.code').push({
        _id: `code_${id}`,
        user: id,
        activeWorld: true,
        modules: clone(state.modules),
        timestamp: state.timestamp,
      });
      table('users.console').push(
        ...state.consoleCommands.map((command, index) => ({
          _id: `console_${id}_${String(index)}`,
          user: id,
          ...command,
        })),
      );
      values.set(env.keys.MEMORY + id, state.memory);
      values.set(env.keys.PUBLIC_MEMORY_SEGMENTS + id, state.publicSegments ?? '');
      hashes.set(env.keys.MEMORY_SEGMENTS + id, clone(state.segments));
    }
    values.set(env.keys.GAMETIME, String(world.gameTime));
    hashes.set(
      env.keys.ROOM_EVENT_LOG,
      Object.fromEntries(
        Object.entries(world.roomEventLogs).map(([room, log]) => [room, JSON.stringify(log)]),
      ),
    );
    values.set(
      env.keys.TERRAIN_DATA,
      deflateSync(
        JSON.stringify(Object.entries(world.terrain).map(([room, terrain]) => ({ room, terrain }))),
      ).toString('base64'),
    );
  }
  return { sync, values, hashes, tables };
}
