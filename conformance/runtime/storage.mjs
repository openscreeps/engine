import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';

// RPC/storage adapter, not gameplay implementation. Unsupported queries fail closed rather than
// inventing a result. Documents and ordering are exactly those supplied to the local WorldState.
function matches(document, query = {}) {
  return Object.entries(query).every(([key, value]) => {
    if (key === '$and') return value.every((part) => matches(document, part));
    if (key === '$or') return value.some((part) => matches(document, part));
    const actual = document[key];
    if (value && typeof value === 'object') {
      return Object.entries(value).every(([operator, operand]) => {
        switch (operator) {
          case '$in':
            return operand.includes(actual);
          case '$ne':
            return actual !== operand;
          case '$gt':
            return actual > operand;
          default:
            throw new Error(`Unsupported oracle storage query ${operator}`);
        }
      });
    }
    return actual === value;
  });
}

export function attachFixtureStorage(common) {
  const values = new Map();
  const hashes = new Map();
  const tables = new Map();
  const { env, db, pubsub } = common.storage;
  const clone = (value) => structuredClone(value);
  Object.assign(env, {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => values.set(key, value),
    hmget: async (key, fields) => fields.map((field) => hashes.get(key)?.[field] ?? null),
    hget: async (key, field) => hashes.get(key)?.[field] ?? null,
    hmset: async (key, data) => hashes.set(key, { ...hashes.get(key), ...clone(data) }),
  });
  pubsub.publish = async () => {};
  common.storage._connect = async () => {};
  common.configManager.load = () => {};
  for (const name of common.configManager.config.common.dbCollections) {
    tables.set(name, []);
    db[name] = {
      find: async (query) => clone(tables.get(name).filter((document) => matches(document, query))),
      findOne: async (query) =>
        clone(tables.get(name).find((document) => matches(document, query)) ?? null),
      findEx: async (query, options) => {
        let result = tables.get(name).filter((document) => matches(document, query));
        for (const [key, direction] of Object.entries(options?.sort ?? {})) {
          result = [...result].sort((a, b) => (a[key] - b[key]) * direction);
        }
        return clone(result.slice(0, options?.limit ?? result.length));
      },
      removeWhere: async (query) =>
        tables.set(
          name,
          tables.get(name).filter((document) => !matches(document, query)),
        ),
      update: async (query, update) => {
        for (const document of tables.get(name).filter((entry) => matches(entry, query))) {
          for (const [operator, data] of Object.entries(update)) {
            assert.equal(
              operator,
              '$set',
              'Only data.js inactivity bookkeeping uses fixture DB updates',
            );
            Object.assign(document, clone(data));
          }
        }
      },
    };
  }
  function sync(world, users) {
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
      tables.set(name, clone(Object.values(documents)));
    tables.set('users.code', []);
    tables.set('users.console', []);
    for (const [id, state] of Object.entries(users)) {
      const document = tables.get('users').find((user) => user._id === id);
      assert.ok(document, `Unknown fixture user ${id}`);
      document.activeSegments = clone(state.activeSegments);
      if (state.activeForeignSegment !== undefined)
        document.activeForeignSegment = clone(state.activeForeignSegment);
      tables.get('users.code').push({
        _id: `code_${id}`,
        user: id,
        activeWorld: true,
        modules: clone(state.modules),
        timestamp: state.timestamp,
      });
      tables.get('users.console').push(
        ...state.consoleCommands.map((command, index) => ({
          _id: `console_${id}_${index}`,
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
