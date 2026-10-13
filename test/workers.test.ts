import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  BotRuntime,
  Engine,
  ProcessorPool,
  RunnerPool,
  Simulation,
  type WorkerEvent,
  type WorkerHostCall,
  type WorldState,
} from '../src/index.ts';
import { harvestingWorld } from './fixtures/world.ts';

const SETUP = new URL('./fixtures/worker-setup.ts', import.meta.url).href;

/** Every player: counts ticks in `global` and `Memory`, reports its host, harvests and spawns. */
const PLAYER_CODE = {
  main: `module.exports.loop = function () {
    const start = Date.now();
    while (Date.now() - start < Memory.busyMs) {}
    global.ticks = (global.ticks || 0) + 1;
    Memory.ticks = (Memory.ticks || 0) + 1;
    Memory.globalTicks = global.ticks;
    Memory.pid = typeof hostPid === 'number' ? hostPid : null;
    Memory.greeting = typeof greeting === 'undefined' ? null : greeting;
    Memory.span = [start, Date.now()];
    for (const name in Game.creeps) {
      const creep = Game.creeps[name];
      creep.harvest(creep.pos.findClosestByRange(FIND_SOURCES));
    }
    for (const name in Game.spawns) {
      Game.spawns[name].spawnCreep([WORK, CARRY, MOVE], 'H' + Game.time);
    }
  };`,
};

interface PlayerMemory {
  busyMs: number;
  ticks: number;
  globalTicks: number;
  pid: number | null;
  greeting: unknown;
  span: [number, number];
}

/** `count` independent rooms `W<i>N1`, each owned by player `u<i>` with the harvesting setup. */
function multiRoomWorld(count: number): WorldState {
  const world = harvestingWorld();
  const template = structuredClone(world.roomObjects);
  const user = world.users.u1;
  assert.ok(user);
  for (let i = 2; i <= count; i++) {
    const room = `W${String(i)}N1`;
    const userId = `u${String(i)}`;
    world.terrain[room] = '0'.repeat(2500);
    world.rooms[room] = { _id: room, status: 'normal' };
    world.activeRooms.push(room);
    world.users[userId] = {
      ...structuredClone(user),
      _id: userId,
      username: `player${String(i)}`,
      usernameLower: `player${String(i)}`,
      rooms: [room],
    };
    for (const object of Object.values(template)) {
      const id = `${object._id}_${String(i)}`;
      const copy = { ...structuredClone(object), _id: id, room };
      if (copy.user) copy.user = userId;
      if (typeof copy.name === 'string') copy.name = `${copy.name}_${String(i)}`;
      world.roomObjects[id] = copy;
    }
  }
  return world;
}

function memoryOf(runtime: { getMemory(userId: string): string }, userId: string): PlayerMemory {
  return JSON.parse(runtime.getMemory(userId)) as PlayerMemory;
}

function setBusy(runtime: BotRuntime, userId: string, busyMs: number): void {
  runtime.setMemory(userId, JSON.stringify({ ...memoryOf(runtime, userId), busyMs }));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Records pool events and resolves waits on them. */
class EventLog {
  readonly events: WorkerEvent[] = [];
  #waiters: Array<{ match(event: WorkerEvent): boolean; resolve(event: WorkerEvent): void }> = [];

  readonly listener = (event: WorkerEvent): void => {
    this.events.push(event);
    this.#waiters = this.#waiters.filter((waiter) => {
      if (!waiter.match(event)) return true;
      waiter.resolve(event);
      return false;
    });
  };

  wait(match: (event: WorkerEvent) => boolean): Promise<WorkerEvent> {
    const found = this.events.find(match);
    if (found) return Promise.resolve(found);
    const { promise, resolve } = Promise.withResolvers<WorkerEvent>();
    this.#waiters.push({ match, resolve });
    return promise;
  }

  get pids(): number[] {
    return this.events.flatMap((event) => (event.type === 'started' ? [event.pid] : []));
  }
}

void describe('worker pools', () => {
  void it('runs configured runner and processor processes to the same world as the in-process engine', async () => {
    const log = new EventLog();
    const calls: WorkerHostCall[] = [];
    const runners = new RunnerPool({
      processes: 2,
      threads: 2,
      setup: { module: SETUP },
      onEvent: log.listener,
      onCall: (call) => {
        calls.push(call);
      },
    });
    const processors = new ProcessorPool({
      processes: 2,
      setup: { module: SETUP },
      onEvent: log.listener,
    });
    try {
      const world = multiRoomWorld(4);
      const users = ['u1', 'u2', 'u3', 'u4'];
      using local = new Engine(world);
      using workers = new Engine(world, { runtime: { runners }, simulation: { processors } });
      for (const engine of [local, workers]) {
        for (const userId of users) {
          engine.setCode(userId, PLAYER_CODE);
          engine.setMemory(userId, JSON.stringify({ busyMs: 0 }));
        }
      }
      // Every process is up, so both processes of each pool receive work from the first tick.
      await Promise.all(
        ['engine_runner1', 'engine_runner2', 'engine_processor1', 'engine_processor2'].map((name) =>
          log.wait((event) => event.type === 'ready' && event.name === name),
        ),
      );
      runners.broadcast('greeting', 'hello workers');

      const roomHosts = new Map<string, Set<number>>();
      for (let tick = 0; tick < 4; tick++) {
        // Only the final worker tick measures overlap. Serial reference execution and the
        // persistence ticks need no artificial work; they still run all player actions.
        if (tick === 3) {
          for (const userId of users) {
            workers.setMemory(
              userId,
              JSON.stringify({ ...memoryOf(workers, userId), busyMs: 150 }),
            );
          }
        }
        const expected = await local.tick();
        const actual = await workers.tick();
        assert.deepEqual(actual.simulation.errors, []);
        assert.deepEqual(actual.simulation.processedRooms, expected.simulation.processedRooms);
        for (const [room, stats] of Object.entries(actual.simulation.roomStats)) {
          for (const key of Object.keys(stats.processor ?? {})) {
            const pids = roomHosts.get(room) ?? new Set();
            pids.add(Number(key.slice('pid'.length)));
            roomHosts.set(room, pids);
          }
        }
        for (const userId of users) {
          const result = actual.runtime.users[userId];
          assert.ok(result, `${userId} ran`);
          assert.equal(result.console.error, undefined);
          // The global environment lives across ticks: only the first run is a global reset.
          assert.equal(result.reset, tick === 0);
        }
        // Independent rooms without random draws: concurrent processing equals the ordered one.
        assert.deepEqual(workers.snapshot().world, local.snapshot().world);
      }

      const runnerPids = new Set(runners.status().map((status) => status.pid));
      const processorPids = new Set(processors.status().map((status) => status.pid));
      const hosts = new Set<number>();
      const spans: Array<[number, number]> = [];
      for (const userId of users) {
        const memory = memoryOf(workers, userId);
        assert.equal(memory.ticks, 4);
        assert.equal(memory.globalTicks, 4);
        assert.equal(memory.greeting, 'hello workers');
        assert.ok(memory.pid !== null && runnerPids.has(memory.pid), 'ran in a runner process');
        hosts.add(memory.pid);
        spans.push(memory.span);
        assert.equal(memoryOf(local, userId).pid, null);
      }
      assert.equal(hosts.size, 2, 'players are spread over both runner processes');
      // The four last runs were in flight at once (2 processes x 2 threads).
      const latestStart = Math.max(...spans.map(([start]) => start));
      const earliestEnd = Math.min(...spans.map(([, end]) => end));
      assert.ok(latestStart < earliestEnd, 'runs overlap in time');
      assert.equal(roomHosts.size, 4);
      const processorHosts = new Set([...roomHosts.values()].flatMap((pids) => [...pids]));
      assert.ok([...processorHosts].every((pid) => processorPids.has(pid)));
      assert.equal(processorHosts.size, 2, 'rooms are spread over both processor processes');
      assert.ok(calls.some((call) => call.kind === 'runner' && call.method === 'ran'));
      assert.ok(calls.every((call) => call.worker.startsWith('engine_runner')));
    } finally {
      await Promise.all([runners.close(), processors.close()]);
    }
    assert.equal(log.pids.length, 4);
    assert.ok(
      log.pids.every((pid) => !alive(pid)),
      'no worker process outlives close()',
    );
  });

  void it('fails runs of a crashed runner without saving them and restarts the player on a replacement', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const log = new EventLog();
    let running: (() => void) | undefined;
    await using runners = new RunnerPool({
      processes: 1,
      threads: 1,
      setup: { module: SETUP },
      onEvent: log.listener,
      // The setup's hook calls `ran` before player code: the run is in flight.
      onCall: () => running?.(),
    });
    const world = harvestingWorld();
    using runtime = new BotRuntime({ runners });
    runtime.setCode('u1', PLAYER_CODE);
    runtime.setMemory('u1', JSON.stringify({ busyMs: 0 }));
    const first = await runtime.runTick(world);
    assert.equal(first.users.u1?.reset, true);
    const crashed = memoryOf(runtime, 'u1').pid;
    assert.ok(crashed !== null);

    setBusy(runtime, 'u1', 3000);
    world.gameTime++;
    const inFlight: PromiseWithResolvers<void> = Promise.withResolvers();
    running = inFlight.resolve;
    const tick = runtime.runTick(world);
    await inFlight.promise;
    process.kill(crashed, 'SIGKILL');
    const failure = (await tick).users.u1;
    assert.ok(failure);
    assert.match(failure.console.error ?? '', /engine_runner1 process \d+ exited/);
    assert.deepEqual(failure.intents, { rooms: {} });
    assert.equal(memoryOf(runtime, 'u1').ticks, 1, 'the failed run saved nothing');
    await log.wait((event) => event.type === 'exited' && event.pid === crashed && event.restarting);
    t.mock.timers.tick(1000);

    running = undefined;
    setBusy(runtime, 'u1', 0);
    world.gameTime++;
    const recovered = await runtime.runTick(world);
    assert.equal(recovered.users.u1?.console.error, undefined);
    assert.equal(recovered.users.u1?.reset, true);
    const memory = memoryOf(runtime, 'u1');
    assert.equal(memory.ticks, 2);
    assert.equal(memory.globalTicks, 1, 'the replacement starts a new global environment');
    assert.ok(memory.pid !== null && memory.pid !== crashed && alive(memory.pid));
    assert.equal(runners.status()[0]?.restarts, 1);
  });

  void it('recycles runners after the restart interval and closes without leaking processes', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const log = new EventLog();
    const runners = new RunnerPool({
      processes: 1,
      threads: 1,
      // Advance only the supervisor clock; worker processes and their IPC remain real.
      restartIntervalMs: 1000,
      setup: { module: SETUP },
      onEvent: log.listener,
    });
    try {
      const world = harvestingWorld();
      using runtime = new BotRuntime({ runners });
      runtime.setCode('u1', PLAYER_CODE);
      runtime.setMemory('u1', JSON.stringify({ busyMs: 0 }));
      const first = await runtime.runTick(world);
      assert.equal(first.users.u1?.reset, true);
      const original = memoryOf(runtime, 'u1').pid;
      t.mock.timers.tick(999);
      assert.ok(!log.events.some((event) => event.type === 'recycling'));
      t.mock.timers.tick(1);

      await log.wait((event) => event.type === 'recycling' && event.pid === original);
      // Idle when replaced: the old process exits at once, the replacement takes the slot.
      await log.wait(
        (event) => event.type === 'exited' && event.pid === original && !event.restarting,
      );
      await log.wait((event) => event.type === 'ready' && event.pid !== original);
      world.gameTime++;
      const recycled = await runtime.runTick(world);
      assert.equal(recycled.users.u1?.console.error, undefined);
      assert.equal(recycled.users.u1?.reset, true);
      const memory = memoryOf(runtime, 'u1');
      assert.equal(memory.ticks, 2);
      assert.equal(memory.globalTicks, 1);
      assert.ok(memory.pid !== null && memory.pid !== original);
    } finally {
      await runners.close();
    }
    assert.ok(log.pids.length >= 2);
    assert.ok(log.pids.every((pid) => !alive(pid)));
  });

  void it('retries a room whose processor crashed and reports a room that keeps crashing', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const advanceRestart = (event: WorkerEvent): void => {
      if (event.type === 'exited' && event.restarting) {
        // The exit handler installs the backoff timer after publishing this event.
        queueMicrotask(() => {
          t.mock.timers.tick(1000);
        });
      }
    };
    const directory = mkdtempSync(join(tmpdir(), 'openscreeps-processor-'));
    try {
      const world = multiRoomWorld(3);
      const ordered = new Simulation(world);
      const expected = ordered.tick({});

      await using once = new ProcessorPool({
        processes: 2,
        onEvent: advanceRestart,
        setup: {
          module: SETUP,
          data: { crashRoom: 'W2N1', crashOnceMarker: join(directory, 'crashed') },
        },
      });
      const retried = new Simulation(world, { processors: once });
      const recovered = await retried.tickAsync({});
      assert.deepEqual(recovered.errors, []);
      assert.deepEqual(recovered.processedRooms, expected.processedRooms);
      assert.deepEqual(retried.snapshot(), ordered.snapshot());

      await using always = new ProcessorPool({
        processes: 1,
        onEvent: advanceRestart,
        setup: { module: SETUP, data: { crashRoom: 'W2N1' } },
      });
      const failing = new Simulation(world, { processors: always });
      const before = structuredClone(failing.state.roomObjects);
      const result = await failing.tickAsync({});
      assert.deepEqual(
        result.errors.map((error) => [error.stage, error.room]),
        [['room', 'W2N1']],
      );
      assert.match(
        result.errors[0]?.message ?? '',
        /engine_processor1 process \d+ exited with code 3 while processing room W2N1/,
      );
      assert.deepEqual([...result.processedRooms].sort(), ['W1N1', 'W3N1']);
      for (const [id, object] of Object.entries(before)) {
        if (object.room === 'W2N1') {
          assert.deepEqual(failing.state.roomObjects[id], object, 'no partial room writes');
        }
      }
      assert.equal(failing.state.gameTime, world.gameTime + 1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  void it('leaves the world unchanged when the processor pool is closed', async () => {
    const processors = new ProcessorPool({ processes: 1 });
    const simulation = new Simulation(multiRoomWorld(2), { processors });
    await processors.close();
    const before = simulation.snapshot();
    await assert.rejects(simulation.tickAsync({}), /Processor pool is closed/);
    assert.deepEqual(simulation.snapshot(), before);
    assert.throws(
      () => new Simulation(multiRoomWorld(1), { processors, hooks: { processRoom() {} } }),
      /cannot be combined with processors/,
    );
  });
});
