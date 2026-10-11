import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ivm from 'isolated-vm';
import { getRuntimeBundle } from '../src/runtime/host/bundle.ts';
import { buildRuntimeData, buildWorldIndex } from '../src/runtime/host/runtime-data.ts';
import { SANDBOX_ENTRY_GLOBAL } from '../src/runtime/protocol.ts';
import { verifyReferences } from './references.mjs';
import { createRuntimeOracle } from './runtime/oracle.mjs';
import { fixture, NOW } from './runtime/fixture.mjs';

// Both real player runtimes execute this identical program. Only the measured CPU clock is
// frozen at zero; the original intent recorder and Game.cpu.getUsed implementation run unchanged.
function player() {
  const creep = Game.creeps.worker;
  const rows = [];
  const record = (name, fn) => {
    const before = Game.cpu.getUsed();
    const result = fn();
    rows.push({ name, result, before, after: Game.cpu.getUsed() });
  };
  record('tick-start', () => Game.cpu.getUsed());
  record('move', () => creep.move(RIGHT));
  record('replace-move', () => creep.move(LEFT));
  record('invalid-direction', () => creep.move(99));
  record('fatigued', () => Game.creeps.tired.move(RIGHT));
  record('other-object', () => Game.creeps.empty.move(RIGHT));
  record('cancel-move', () => creep.cancelOrder('move'));
  record('cancel-missing', () => creep.cancelOrder('move'));
  record('reissue-move', () => creep.move(TOP));
  record('harvest', () => creep.harvest(Game.getObjectById('source')));
  record('replace-harvest', () => creep.harvest(Game.getObjectById('source')));
  record('out-of-range', () => creep.harvest(Game.getObjectById('drySource')));
  record('say-free', () => creep.say('one'));
  record('replace-say-free', () => creep.say('two'));
  record('cancel-free-say', () => creep.cancelOrder('say'));
  record('say-again', () => creep.say('three'));
  record('pull-free', () => creep.pull(Game.creeps.empty));
  record('cancel-free-pull', () => creep.cancelOrder('pull'));
  record('notify', () => Game.notify('one'));
  record('notify-again', () => Game.notify('two'));
  for (let i = 0; i < 52; i++) record(`market-cancel-${i}`, () => Game.market.cancelOrder('own'));
  record('dry-run-spawn', () => Game.spawns.Spawn1.spawnCreep([MOVE], 'test', { dryRun: true }));
  record('spawn', () => Game.spawns.Spawn1.spawnCreep([MOVE], 'test'));
  record('spawn-busy', () => Game.spawns.Spawn1.spawnCreep([MOVE], 'test2'));
  // A real capped pushByName call: ten market deals may be queued each tick.
  for (let i = 0; i < 12; i++) record(`deal-${i}`, () => Game.market.deal('order', 1, 'W1N1'));
  Memory.cpuProbe = rows;
}

verifyReferences(['engine', 'common', 'driver']);
const world = fixture();
world.marketOrders.own = { ...world.marketOrders.order, _id: 'own', user: 'u1' };
const modules = { main: `module.exports.loop = ${player.toString()};` };
const oracle = await createRuntimeOracle({ now: NOW, freezeCpuTime: true });
const isolate = new ivm.Isolate({ memoryLimit: 256 });
let comparisons = 0;
try {
  const context = await isolate.createContext();
  await context.global.set('global', context.global.derefInto());
  await (await isolate.compileScript(await getRuntimeBundle())).run(context);
  const entry = await context.global.get(SANDBOX_ENTRY_GLOBAL, { reference: true });
  const install = entry.getSync('install', { reference: true });
  const prepare = entry.getSync('prepare', { reference: true });
  const execute = entry.getSync('execute', { reference: true });
  const setTerrain = entry.getSync('setStaticTerrainData', { reference: true });
  await context.global.set('_isolate', isolate);
  await context.global.set('_context', context);
  await context.global.set('_cpuMark', new ivm.Callback(() => {}));
  await context.eval(`_isolate = {
    cpuTime: 0n,
    compileScriptSync: _isolate.compileScriptSync.bind(_isolate),
    getHeapStatisticsSync: _isolate.getHeapStatisticsSync.bind(_isolate)
  };`);
  await install.apply(undefined, []);
  const rooms = Object.entries(world.terrain);
  const terrain = new Uint8Array(rooms.length * 2500);
  const offsets = {};
  rooms.forEach(([room, data], index) => {
    offsets[room] = index * 2500;
    for (let i = 0; i < 2500; i++) terrain[index * 2500 + i] = Number(data[i]);
  });
  await setTerrain.apply(undefined, [
    new ivm.ExternalCopy(terrain.buffer).copyInto(),
    JSON.stringify(offsets),
  ]);
  oracle.setCode('u1', modules);
  oracle.setMemory('u1', '{}');
  let memory = '{}';
  const ticks = [];
  for (let tick = 0; tick < 3; tick++) {
    const data = buildRuntimeData(
      world,
      buildWorldIndex(world, NOW),
      'u1',
      {
        modules,
        codeTimestamp: 1,
        memory,
        consoleCommands: [],
        activeSegments: [],
        segments: {},
        customObjectPrototypes: [],
        account: {
          ptr: false,
          shardLimits: {},
          shardLimitsCooldownTime: 0,
          now: NOW,
          interShardLocal: '',
          interShardRemote: {},
          interShardSegment: '',
        },
      },
      500,
      1000,
      () => undefined,
    );
    assert.ok(data);
    const original = await oracle.run(world, 'u1');
    const preparation = await prepare.apply(undefined, [JSON.stringify(data), 500, 1000], {
      timeout: 5000,
      result: { copy: true },
    });
    assert.equal(preparation, undefined);
    const local = await execute.apply(undefined, [], {
      timeout: 5000,
      result: { copy: true },
    });
    assert.equal(original.type, 'done', original.error);
    assert.equal(local.type, 'done', local.error);
    const expected = JSON.parse(original.memory).cpuProbe;
    const actual = JSON.parse(local.memory).cpuProbe;
    assert.deepEqual(
      actual,
      expected,
      `tick ${tick}: return codes and exact Game.cpu.getUsed before/after each action`,
    );
    assert.equal(
      local.intentsCpu,
      original.intentsCpu,
      `tick ${tick}: exact unrounded accumulator`,
    );
    assert.deepEqual(
      JSON.parse(JSON.stringify(local.intentsList)),
      JSON.parse(JSON.stringify(original.intentsList)),
      `tick ${tick}: final raw intents`,
    );
    assert.equal(expected[0].before, 0, 'intent CPU resets on every tick');
    const byName = Object.fromEntries(expected.map((row) => [row.name, row]));
    assert.equal(byName.move.result, 0);
    for (const name of [
      'harvest',
      'say-free',
      'pull-free',
      'notify',
      'notify-again',
      'dry-run-spawn',
      'spawn',
      'market-cancel-0',
    ]) {
      assert.equal(byName[name].result, 0, `${name}: fixture actually succeeds`);
    }
    assert.equal(byName.move.after, 0.2);
    for (const name of [
      'replace-move',
      'invalid-direction',
      'fatigued',
      'replace-harvest',
      'out-of-range',
      'say-free',
      'replace-say-free',
      'pull-free',
      'dry-run-spawn',
    ]) {
      assert.equal(byName[name].after, byName[name].before, `${name}: no extra artificial cost`);
    }
    assert.equal(byName['cancel-move'].result, 0);
    assert.equal(byName['cancel-missing'].result, -5);
    assert.equal(byName['cancel-free-say'].after, byName['cancel-free-say'].before - 0.2);
    assert.equal(byName['cancel-free-pull'].after, byName['cancel-free-pull'].before - 0.2);
    assert.equal(byName['deal-0'].result, 0, 'deal fixture actually queues an intent');
    assert.equal(byName['deal-10'].result, -8, 'deal cap reached');
    assert.equal(byName['deal-10'].after, byName['deal-10'].before);
    assert.equal(
      byName['market-cancel-50'].result,
      0,
      'upstream silently accepts capped cancellation',
    );
    assert.equal(byName['market-cancel-50'].after, byName['market-cancel-50'].before);
    comparisons += expected.length + 2;
    ticks.push({
      tick: world.gameTime,
      actions: expected.length,
      artificialCpu: original.intentsCpu,
    });
    memory = local.memory;
    world.gameTime++;
  }
  console.log(
    JSON.stringify(
      {
        suite: 'artificial-cpu',
        status: 'passed',
        comparisons,
        ticks,
        references: JSON.parse(
          readFileSync(new URL('../reference-versions.json', import.meta.url), 'utf8'),
        ),
        clock: 'isolate cpuTime fixed at zero on both sides; intent arithmetic untouched',
        excludes: ['elapsed CPU', 'host bucket charging/recount', 'timeout and reset policy'],
      },
      null,
      2,
    ),
  );
} finally {
  oracle.dispose();
  isolate.dispose();
}
