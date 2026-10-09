import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createWorldState, Simulation } from '../src/simulation/index.ts';

void describe('account global intents', () => {
  void it('credits generated pixels and consumes one CPU unlock per available unlock', () => {
    const world = createWorldState({
      users: { u1: { _id: 'u1', resources: { cpuUnlock: 1 }, cpuUnlockedTime: 0 } },
    });
    const simulation = new Simulation(world, { now: () => 5000 });
    const result = simulation.tick({
      u1: { rooms: {}, global: { generatePixel: [{}, {}], unlockCpu: [{}, {}] } },
    });
    assert.deepEqual(result.errors, []);

    const user = simulation.snapshot().users.u1;
    assert.ok(user);
    assert.deepEqual(user.resources, { cpuUnlock: 0, pixel: 2 });
    assert.equal(user.cpuUnlockedTime, 5000 + 24 * 3600 * 1000);
  });

  void it('extends an unlock that has not expired yet', () => {
    const until = 10_000 + 3600 * 1000;
    const world = createWorldState({
      users: { u1: { _id: 'u1', resources: { cpuUnlock: 2 }, cpuUnlockedTime: until } },
    });
    const simulation = new Simulation(world, { now: () => 10_000 });
    simulation.tick({ u1: { rooms: {}, global: { unlockCpu: [{}] } } });
    const user = simulation.snapshot().users.u1;
    assert.ok(user);
    assert.equal(user.cpuUnlockedTime, until + 24 * 3600 * 1000);
    assert.deepEqual(user.resources, { cpuUnlock: 1 });
  });

  void it('activates restricted-shard access with an access key and expires it', () => {
    const day = 24 * 3600 * 1000;
    let now = 1_000;
    const world = createWorldState({
      restrictedShard: true,
      users: { u1: { _id: 'u1', resources: { accessKey: 1 } } },
    });
    const simulation = new Simulation(world, { now: () => now });

    simulation.tick({ u1: { rooms: {}, global: { activateAccess: [{}, {}] } } });
    let user = simulation.snapshot().users.u1;
    assert.ok(user);
    assert.deepEqual(user.resources, { accessKey: 0 });
    assert.equal(user.shardAccessTime, 1_000 + 30 * day);
    assert.equal(user.shardAccess, true);

    now = 1_000 + 30 * day;
    simulation.tick({});
    user = simulation.snapshot().users.u1;
    assert.ok(user);
    assert.equal(user.shardAccess, false);
  });

  void it('ignores access keys on unrestricted shards and for unlimited access', () => {
    const world = createWorldState({
      users: { u1: { _id: 'u1', resources: { accessKey: 1 } } },
    });
    const open = new Simulation(world, { now: () => 0 });
    open.tick({ u1: { rooms: {}, global: { activateAccess: [{}] } } });
    const openUser = open.snapshot().users.u1;
    assert.ok(openUser);
    assert.deepEqual(openUser.resources, { accessKey: 1 });
    assert.equal(openUser.shardAccess, undefined);

    const restricted = new Simulation(
      createWorldState({
        restrictedShard: true,
        users: { u1: { _id: 'u1', resources: { accessKey: 1 }, shardAccessUnlimited: true } },
      }),
      { now: () => 0 },
    );
    restricted.tick({ u1: { rooms: {}, global: { activateAccess: [{}] } } });
    const unlimited = restricted.snapshot().users.u1;
    assert.ok(unlimited);
    assert.deepEqual(unlimited.resources, { accessKey: 1 });
    assert.equal(unlimited.shardAccess, true);
  });
});
