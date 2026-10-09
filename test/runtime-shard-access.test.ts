import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Engine } from '../src/index.ts';
import { createWorldState, type UserDoc, type WorldState } from '../src/simulation/index.ts';

const DAY = 24 * 3600 * 1000;
const MONTH = 30 * DAY;

function shardWorld(restrictedShard: boolean, user: Partial<UserDoc>): WorldState {
  return createWorldState({
    gameTime: 1,
    restrictedShard,
    terrain: { W1N1: '0'.repeat(2500) },
    rooms: { W1N1: { _id: 'W1N1', status: 'normal' } },
    activeRooms: ['W1N1'],
    users: {
      u1: { _id: 'u1', username: 'alice', cpu: 100, cpuAvailable: 10000, rooms: [], ...user },
    },
    roomObjects: {
      creep1: {
        _id: 'creep1',
        type: 'creep',
        room: 'W1N1',
        x: 10,
        y: 10,
        name: 'Scout',
        user: 'u1',
        body: [{ type: 'move', hits: 100 }],
        store: {},
        storeCapacity: 0,
        hits: 100,
        hitsMax: 100,
        ageTime: 1500,
        fatigue: 0,
      },
    },
  });
}

/** Logs `access|accessTime|activateAccess()` (or `access|accessTime` with `activate: false`). */
const accessCode = (activate: boolean) => ({
  main: `module.exports.loop = function () {
    console.log([Game.shard.access, 'accessTime' in Game.shard ? Game.shard.accessTime : 'none',
      ${activate ? 'Game.shard.activateAccess()' : "'skip'"}].join('|'));
  };`,
});

void describe('restricted shard access', () => {
  void it('activates, extends, depletes and expires access through runtime and simulation', async () => {
    let now = 1_000_000;
    const clock = () => now;
    using engine = new Engine(shardWorld(true, { resources: { accessKey: 2 } }), {
      simulation: { now: clock },
      runtime: { now: clock },
    });

    engine.setCode('u1', accessCode(true));
    let tick = await engine.tick();
    assert.equal(tick.runtime.users.u1?.console.log[0]?.message, 'false|none|0');
    let user = engine.snapshot().world.users.u1;
    assert.ok(user);
    assert.equal(user.resources?.accessKey, 1);
    assert.equal(user.shardAccessTime, 1_000_000 + MONTH);
    assert.equal(user.shardAccess, true);

    now += DAY;
    tick = await engine.tick();
    assert.equal(
      tick.runtime.users.u1?.console.log[0]?.message,
      `true|${String(1_000_000 + MONTH)}|0`,
    );
    user = engine.snapshot().world.users.u1;
    assert.ok(user);
    assert.equal(user.resources?.accessKey, 0);
    assert.equal(user.shardAccessTime, 1_000_000 + 2 * MONTH);

    tick = await engine.tick();
    assert.equal(
      tick.runtime.users.u1?.console.log[0]?.message,
      `true|${String(1_000_000 + 2 * MONTH)}|-6`,
    );
    assert.equal(engine.snapshot().world.users.u1?.shardAccessTime, 1_000_000 + 2 * MONTH);

    now = 1_000_000 + 2 * MONTH + 1;
    engine.setCode('u1', accessCode(false));
    tick = await engine.tick();
    assert.equal(tick.runtime.users.u1?.console.log[0]?.message, 'false|none|skip');
    assert.equal(engine.snapshot().world.users.u1?.shardAccess, false);
  });

  void it('reports permanent access on non-restricted shards and for unlimited grants', async () => {
    using open = new Engine(shardWorld(false, { resources: { accessKey: 3 } }));
    open.setCode('u1', accessCode(true));
    const openTick = await open.tick();
    assert.equal(openTick.runtime.users.u1?.console.log[0]?.message, 'true|none|-7');
    assert.equal(open.snapshot().world.users.u1?.resources?.accessKey, 3);

    using unlimited = new Engine(
      shardWorld(true, { shardAccessUnlimited: true, resources: { accessKey: 3 } }),
    );
    unlimited.setCode('u1', accessCode(true));
    const unlimitedTick = await unlimited.tick();
    assert.equal(unlimitedTick.runtime.users.u1?.console.log[0]?.message, 'true|none|-8');
    assert.equal(unlimited.snapshot().world.users.u1?.resources?.accessKey, 3);
  });
});
