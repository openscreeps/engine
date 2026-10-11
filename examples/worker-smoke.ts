/*
 * Live smoke of the launcher-style worker topology: player runners and room processors in
 * supervised processes, with a runner killed during a player run and a processor killed during a
 * tick. The worker engine must recover by itself and end in the same world as the in-process
 * engine (the rooms are independent and draw no random numbers), and no process may outlive it.
 *
 *   node examples/worker-smoke.ts [ticks=12] [runners=2] [threads=2] [processors=2]
 */

import assert from 'node:assert/strict';
import {
  createWorldState,
  Engine,
  ProcessorPool,
  RunnerPool,
  type WorkerEvent,
  type WorldState,
} from '../src/index.ts';

const [ticks = 12, runnerCount = 2, threads = 2, processorCount = 2] = process.argv
  .slice(2)
  .map(Number);
const ROOMS = 6;

const PLAYER_CODE = {
  main: `module.exports.loop = function () {
    const start = Date.now();
    while (Date.now() - start < 50) {}
    global.ticks = (global.ticks || 0) + 1;
    Memory.ticks = (Memory.ticks || 0) + 1;
    Memory.globalTicks = global.ticks;
    for (const name in Game.creeps) {
      const creep = Game.creeps[name];
      creep.harvest(creep.pos.findClosestByRange(FIND_SOURCES));
    }
    for (const name in Game.spawns) {
      Game.spawns[name].spawnCreep([WORK, CARRY, MOVE], 'H' + Game.time);
    }
  };`,
};

function world(): WorldState {
  const state = createWorldState({ gameTime: 1 });
  for (let i = 1; i <= ROOMS; i++) {
    const room = `W${String(i)}N1`;
    const user = `u${String(i)}`;
    state.terrain[room] = '0'.repeat(2500);
    state.rooms[room] = { _id: room, status: 'normal' };
    state.activeRooms.push(room);
    state.users[user] = {
      _id: user,
      username: `player${String(i)}`,
      usernameLower: `player${String(i)}`,
      cpu: 100,
      cpuAvailable: 10000,
      gcl: 0,
      power: 0,
      money: 0,
      rooms: [room],
      active: 10000,
    };
    const objects = {
      [`ctrl${String(i)}`]: {
        type: 'controller',
        x: 25,
        y: 25,
        user,
        level: 1,
        progress: 0,
        downgradeTime: 20001,
        safeMode: null,
        safeModeAvailable: 1,
        safeModeCooldown: null,
        isPowerEnabled: false,
      },
      [`spawn${String(i)}`]: {
        type: 'spawn',
        x: 20,
        y: 20,
        name: `Spawn${String(i)}`,
        user,
        store: { energy: 300 },
        storeCapacityResource: { energy: 300 },
        hits: 5000,
        hitsMax: 5000,
        spawning: null,
        notifyWhenAttacked: true,
      },
      [`src${String(i)}`]: {
        type: 'source',
        x: 10,
        y: 10,
        energy: 3000,
        energyCapacity: 3000,
        nextRegenerationTime: null,
      },
      [`creep${String(i)}`]: {
        type: 'creep',
        x: 11,
        y: 11,
        name: `Harvester${String(i)}`,
        user,
        body: [
          { type: 'work', hits: 100 },
          { type: 'carry', hits: 100 },
          { type: 'move', hits: 100 },
        ],
        store: { energy: 0 },
        storeCapacity: 50,
        hits: 300,
        hitsMax: 300,
        fatigue: 0,
        ageTime: 1501,
        spawning: false,
        notifyWhenAttacked: true,
        actionLog: {},
      },
    };
    for (const [id, object] of Object.entries(objects)) {
      state.roomObjects[id] = { _id: id, room, ...object };
    }
  }
  return state;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const events: WorkerEvent[] = [];
const log = (event: WorkerEvent): void => {
  events.push(event);
  if (event.type !== 'output') {
    console.log(
      `[${event.name}] ${event.type}${'pid' in event ? ` pid ${String(event.pid)}` : ''}`,
    );
  }
};
const runners = new RunnerPool({ processes: runnerCount, threads, onEvent: log });
const processors = new ProcessorPool({ processes: processorCount, onEvent: log });
const users = Array.from({ length: ROOMS }, (_, i) => `u${String(i + 1)}`);
const runnerCrashTick = Math.min(3, ticks - 2);
const processorCrashTick = Math.min(6, ticks - 1);
let failedRuns = 0;
let resets = 0;

try {
  const initial = world();
  using local = new Engine(initial);
  using workers = new Engine(initial, { runtime: { runners }, simulation: { processors } });
  for (const engine of [local, workers]) {
    for (const user of users) engine.setCode(user, PLAYER_CODE);
  }
  const started = Date.now();
  for (let tick = 0; tick < ticks; tick++) {
    const expected = await local.tick();
    const tickStart = Date.now();
    const running = workers.tick();
    if (tick === runnerCrashTick) {
      // A runner dies while its players' runs are in flight.
      while (!(runners.status()[0]?.pending ?? 0)) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      const victim = runners.status()[0]?.pid;
      assert.ok(victim !== undefined);
      process.kill(victim, 'SIGKILL');
    }
    if (tick === processorCrashTick) {
      // A processor dies at the start of a tick; its rooms go to the other processes.
      const victim = processors.status()[0]?.pid;
      assert.ok(victim !== undefined);
      process.kill(victim, 'SIGKILL');
    }
    const actual = await running;
    assert.deepEqual(actual.simulation.errors, [], `tick ${String(tick)} room errors`);
    assert.deepEqual(actual.simulation.processedRooms, expected.simulation.processedRooms);
    for (const user of users) {
      const result = actual.runtime.users[user];
      assert.ok(result);
      if (result.console.error !== undefined) {
        assert.equal(tick, runnerCrashTick, `unexpected failure: ${result.console.error}`);
        failedRuns++;
      }
      if (result.reset && tick > 0) resets++;
    }
    console.log(
      `tick ${String(tick)} done in ${String(Date.now() - tickStart)} ms (runners ${runners
        .status()
        .map((status) => `${status.name}:${String(status.pid)}`)
        .join(',')})`,
    );
    // Until a run fails, both engines saw the same intents and must hold the same world.
    if (failedRuns === 0) {
      assert.deepEqual(workers.snapshot().world, local.snapshot().world);
    }
  }
  assert.ok(failedRuns > 0, 'the runner crash failed the in-flight runs');
  // Players of the crashed runner restart on another process: failed ones and queued ones.
  assert.ok(resets >= failedRuns, 'players of the crashed runner restarted');
  assert.equal(workers.snapshot().world.gameTime, 1 + ticks);
  for (const user of users) {
    const memory = JSON.parse(workers.getMemory(user)) as { ticks: number; globalTicks: number };
    assert.ok(memory.ticks === ticks || memory.ticks === ticks - 1, `${user} memory ticks`);
  }
  assert.ok(
    events.filter((event) => event.type === 'exited' && event.restarting).length >= 2,
    'both crashed processes were replaced',
  );
  console.log(
    `OK: ${String(ticks)} ticks in ${String(Date.now() - started)} ms, ${String(failedRuns)} runs failed by the runner crash and restarted`,
  );
} finally {
  await Promise.all([runners.close(), processors.close()]);
}
const leaked = events.flatMap((event) =>
  event.type === 'started' && alive(event.pid) ? [event.pid] : [],
);
assert.deepEqual(leaked, [], 'no worker process outlives close()');
console.log('OK: all worker processes exited');
