import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BotRuntime, InterShardStore } from '../src/runtime/index.ts';
import { createWorldState, type WorldState } from '../src/simulation/index.ts';

/** Two players, each with one creep in its own room. */
function twoPlayerWorld(): WorldState {
  const user = (id: string, username: string) => ({
    _id: id,
    username,
    cpu: 100,
    cpuAvailable: 10000,
    gcl: 0,
    power: 0,
    money: 0,
    rooms: [],
    active: 10000,
    resources: { cpuUnlock: 1 },
  });
  const creep = (id: string, room: string, owner: string, name: string) => ({
    _id: id,
    type: 'creep',
    room,
    x: 25,
    y: 25,
    name,
    user: owner,
    body: [{ type: 'move', hits: 100 }],
    store: {},
    storeCapacity: 0,
    hits: 100,
    hitsMax: 100,
    ageTime: 1500,
    fatigue: 0,
  });
  return createWorldState({
    gameTime: 10,
    terrain: { W1N1: '0'.repeat(2500), W2N1: '0'.repeat(2500) },
    rooms: { W1N1: { _id: 'W1N1', status: 'normal' }, W2N1: { _id: 'W2N1', status: 'normal' } },
    users: { u1: user('u1', 'mallory'), u2: user('u2', 'bob') },
    roomObjects: {
      c1: creep('c1', 'W1N1', 'u1', 'Evil'),
      c2: creep('c2', 'W2N1', 'u2', 'Good'),
    },
  });
}

const honestCode = {
  main: `module.exports.loop = function () {
    Memory.ticks = (Memory.ticks || 0) + 1;
    Game.creeps.Good.say('hi');
    Game.creeps.Good.move(TOP);
  };`,
};

void describe('runtime isolation', () => {
  void it('removes every host entry point from the player global before player code runs', async () => {
    using runtime = new BotRuntime();
    runtime.setCode('u1', {
      main: `module.exports.loop = function () {
        console.log([typeof __screepsRuntime, typeof _isolate, typeof _context, typeof _halt, typeof _cpuMark, typeof _ivm].join());
      };`,
    });
    const result = await runtime.runUser(twoPlayerWorld(), 'u1');
    assert.equal(result?.console.error, undefined);
    assert.equal(
      result?.console.log[0]?.message,
      'undefined,undefined,undefined,undefined,undefined,undefined',
    );
  });

  void it('transports results without invoking player hooks on the serialization path', async () => {
    using runtime = new BotRuntime();
    runtime.setCode('u1', {
      main: `module.exports.loop = function () {
        if (global.sabotaged) {
          console.log('toJSON calls: ' + global.toJSONCalls);
          return;
        }
        global.sabotaged = true;
        global.toJSONCalls = 0;
        JSON.stringify = function () { return '{"type":"done"}'; };
        Math.ceil = function () { return -1000000; };
        // Count calls on result/intent shaped objects only: runtime preparation of the next tick
        // legitimately stringifies resources and constants (upstream game.js does the same).
        Object.defineProperty(Object.prototype, 'toJSON', {
          value: function () {
            if (['intentsList', 'direction'].some((key) => Object.prototype.hasOwnProperty.call(this, key))) {
              global.toJSONCalls++;
            }
            return this;
          },
          configurable: true,
        });
        Game.creeps.Evil.move(TOP);
      };`,
    });
    runtime.setCode('u2', honestCode);
    const world = twoPlayerWorld();
    const tick = await runtime.runTick(world);
    const evil = tick.users.u1;
    assert.ok(evil);
    assert.equal(evil.console.error, undefined);
    assert.deepEqual(Object.keys(evil.intents.rooms.W1N1?.c1 ?? {}), ['move']);
    assert.ok(evil.cpu.charged >= 1);
    const good = tick.users.u2;
    assert.ok(good);
    assert.equal(good.console.error, undefined);
    assert.deepEqual(Object.keys(good.intents.rooms.W2N1?.c2 ?? {}).sort(), ['move', 'say']);
    assert.deepEqual(JSON.parse(runtime.getMemory('u2')), { ticks: 1 });
    const next = await runtime.runUser(world, 'u1');
    assert.equal(next?.console.log[0]?.message, 'toJSON calls: 0');
  });

  void it('does not start a run without available CPU (zero shard allocation, empty bucket)', async () => {
    const store = new InterShardStore();
    store.setShardLimits('u2', { shard0: 0, shard1: 100 }, 0);
    const world = twoPlayerWorld();
    const user = world.users.u2;
    assert.ok(user);
    user.cpuAvailable = 0;
    using runtime = new BotRuntime({ interShard: store });
    runtime.setCode('u2', { main: `module.exports.loop = function () { while (true) {} };` });
    const result = await runtime.runUser(world, 'u2');
    assert.ok(result);
    assert.equal(result.console.error, 'Script execution has been terminated: CPU bucket is empty');
    assert.equal(result.reset, false);
    assert.equal(result.cpu.bucket, 0);
  });

  void it('measures CPU on the host so a player cannot forge its usage or refill its bucket', async () => {
    using runtime = new BotRuntime();
    runtime.setCode('u1', {
      main: `module.exports.loop = function () {
        Math.ceil = function () { return 0; };
        Date.now = function () { return 0; };
        let x = 0;
        for (let i = 0; i < 3e7; i++) { x += i % 7; }
        Memory.x = x;
      };`,
    });
    const result = await runtime.runUser(twoPlayerWorld(), 'u1');
    assert.ok(result);
    assert.equal(result.console.error, undefined);
    assert.ok(result.cpu.used >= 5, `expected measurable CPU, got ${String(result.cpu.used)}`);
    assert.equal(result.cpu.bucket, Math.min(10000, 10000 + 100 - result.cpu.used));
  });

  void it('isolates a runaway player from the others', async () => {
    using runtime = new BotRuntime();
    runtime.setCode('u1', { main: `module.exports.loop = function () { while (true) {} };` });
    runtime.setCode('u2', honestCode);
    const tick = await runtime.runTick(twoPlayerWorld());
    assert.match(tick.users.u1?.console.error ?? '', /CPU time limit reached/);
    assert.equal(tick.users.u2?.console.error, undefined);
    assert.ok(tick.intents.u2?.rooms.W2N1?.c2);
  });

  void it('serializes overlapping runs of one player and rejects state changes while it runs', async () => {
    using runtime = new BotRuntime();
    runtime.setCode('u2', honestCode);
    const world = twoPlayerWorld();
    const first = runtime.runUser(world, 'u2');
    const second = runtime.runUser(world, 'u2');
    assert.throws(() => {
      runtime.setMemory('u2', '{}');
    }, /is running/);
    assert.throws(() => {
      runtime.setCode('u2', honestCode);
    }, /is running/);
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a?.console.error, undefined);
    assert.equal(b?.console.error, undefined);
    assert.deepEqual(JSON.parse(runtime.getMemory('u2')), { ticks: 2 });
    runtime.setMemory('u2', '{"ticks":5}');
    assert.equal(runtime.getMemory('u2'), '{"ticks":5}');
  });

  void it('exposes the account APIs backed by runtime and shared shard state', async () => {
    const store = new InterShardStore();
    store.setData('shard1', 'u2', 'from shard1');
    using runtime = new BotRuntime({ interShard: store });
    runtime.setCode('u2', {
      main: `module.exports.loop = function () {
        InterShardMemory.setLocal('hello');
        console.log(Game.shard.name, Game.shard.type, Game.shard.ptr, InterShardMemory.getRemote('shard1'),
          JSON.stringify(Game.cpu.shardLimits), Game.cpu.unlocked, Game.cpu.generatePixel(), Game.cpu.unlock(),
          Game.cpu.unlock(), Game.cpu.setShardLimits({ shard0: 1 }));
      };`,
    });
    const result = await runtime.runUser(twoPlayerWorld(), 'u2');
    assert.ok(result);
    assert.equal(result.console.error, undefined);
    assert.equal(
      result.console.log[0]?.message,
      `shard0 normal false from shard1 {"shard0":100} false 0 0 ${String(-6)} ${String(-10)}`,
    );
    const global = result.intents.global;
    assert.ok(global);
    assert.deepEqual(global.generatePixel, [{}]);
    assert.deepEqual(global.unlockCpu, [{}]);
    assert.equal(store.getData('shard0', 'u2'), 'hello');
    assert.ok(result.cpu.bucket < 1000);
  });

  void it('exposes callable upstream-style constructors usable for ES5 and ES2015 subclassing', async () => {
    using runtime = new BotRuntime();
    runtime.setCode('u2', {
      main: `module.exports.loop = function () {
        function LegacyCreep(id) { Creep.call(this, id); }
        LegacyCreep.prototype = Object.create(Creep.prototype);
        const legacy = new LegacyCreep('c2');
        class ModernCreep extends Creep {}
        const modern = new ModernCreep('c2');
        console.log(legacy.name, legacy instanceof Creep, legacy instanceof RoomObject, legacy.pos.roomName,
          modern.name, modern instanceof ModernCreep, Creep.name === '', Creep.length, Creep.prototype.move.name === '',
          RoomPosition.name, Object.keys(Creep.prototype).includes('move'));
      };`,
    });
    const result = await runtime.runUser(twoPlayerWorld(), 'u2');
    assert.ok(result);
    assert.equal(result.console.error, undefined);
    assert.equal(
      result.console.log[0]?.message,
      'Good true true W2N1 Good true true 1 true RoomPosition true',
    );
  });

  void it('treats an explicit zero shard allocation as a finite budget', async () => {
    const store = new InterShardStore();
    store.setShardLimits('u2', { shard0: 0, shard1: 100 }, 0);
    using runtime = new BotRuntime({ interShard: store });
    runtime.setCode('u2', {
      main: `module.exports.loop = function () {
        console.log(Game.cpu.limit, Game.cpu.tickLimit, Game.cpu.bucket,
          Game.cpu.generatePixel(), Game.cpu.generatePixel(), Game.cpu.generatePixel());
      };`,
    });
    const result = await runtime.runUser(twoPlayerWorld(), 'u2');
    assert.ok(result);
    assert.equal(result.console.error, undefined);
    assert.equal(result.console.log[0]?.message, '0 500 10000 0 -6 -6');
    assert.deepEqual(result.intents.global?.generatePixel, [{}]);
    assert.equal(result.cpu.limit, 500);
    assert.equal(result.cpu.bucket, -result.cpu.used);
  });

  void it('transports unlimited CPU (no users.cpu) into the sandbox as Infinity', async () => {
    const world = twoPlayerWorld();
    const user = world.users.u2;
    assert.ok(user);
    delete user.cpu;
    using runtime = new BotRuntime();
    runtime.setCode('u2', {
      main: `module.exports.loop = function () { console.log(Game.cpu.tickLimit, Game.cpu.bucket); };`,
    });
    const result = await runtime.runUser(world, 'u2');
    assert.ok(result);
    assert.equal(result.console.log[0]?.message, 'Infinity Infinity');
    assert.equal(result.cpu.limit, Infinity);
  });

  void it('charges notify entries like the driver intent count', async () => {
    using runtime = new BotRuntime();
    runtime.setCode('u2', {
      main: `module.exports.loop = function () {
        for (let i = 0; i < 25; i++) { Game.notify('n' + i); }
        Game.creeps.Good.say('free');
      };`,
    });
    const result = await runtime.runUser(twoPlayerWorld(), 'u2');
    assert.ok(result);
    assert.equal(result.console.error, undefined);
    assert.equal(result.intents.notify?.length, 20);
    assert.ok(
      result.cpu.charged >= 4,
      `20 notifications cost 4 CPU, charged ${String(result.cpu.charged)}`,
    );
    assert.equal(result.cpu.bucket, Math.min(10000, 10000 + 100 - result.cpu.charged));
  });

  void it('runs only active users with a positive CPU allocation, like the driver runner', async () => {
    const world = twoPlayerWorld();
    const inactive = world.users.u1;
    const unlimited = world.users.u2;
    assert.ok(inactive && unlimited);
    inactive.active = 0;
    delete unlimited.cpu;
    using runtime = new BotRuntime();
    runtime.setCode('u1', honestCode);
    runtime.setCode('u2', honestCode);
    const tick = await runtime.runTick(world);
    assert.deepEqual(Object.keys(tick.users), []);
  });
});
