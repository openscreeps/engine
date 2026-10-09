import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BotRuntime } from '../src/runtime/index.ts';
import { verifyReferences } from './references.mjs';
import { createRuntimeOracle } from './runtime/oracle.mjs';
import { fixture, spatialWorld, NOW } from './runtime/fixture.mjs';
import {
  playerModules,
  gameplay,
  persistence,
  rawMemory,
  invalidMemory,
  memoryJSON,
  positions,
  legacyPaths,
  mapRouting,
  costMatrix,
  stores,
  nativePaths,
} from './runtime/player.mjs';

verifyReferences(['engine', 'common', 'driver']);
const scenarios = [
  { name: 'gameplay', loop: gameplay, ticks: 1, memory: '{}' },
  { name: 'persistence', loop: persistence, ticks: 4, memory: '{"seed":true}' },
  { name: 'raw-memory', loop: rawMemory, ticks: 1, memory: '{"seed":true}' },
  { name: 'invalid-memory', loop: invalidMemory, ticks: 1, memory: 'not json' },
  { name: 'memory-json', loop: memoryJSON, ticks: 1, memory: '{}' },
  ...[
    ['null', 'null'],
    ['number', '5'],
    ['string', '"text"'],
    ['boolean', 'true'],
    ['array', '[]'],
    ['own-proto', '{"__proto__":{"kept":true},"seed":1}'],
  ].map(([name, memory]) => ({
    name: `memory-root-${name}`,
    loop: invalidMemory,
    ticks: 1,
    memory,
  })),
  // Targeted core API scenarios: observations are compared leaf by leaf every tick.
  { name: 'positions', loop: positions, ticks: 3, memory: '{}', world: spatialWorld },
  { name: 'legacy-paths', loop: legacyPaths, ticks: 1, memory: '{}', world: spatialWorld },
  { name: 'map', loop: mapRouting, ticks: 2, memory: '{}', world: spatialWorld },
  { name: 'cost-matrix', loop: costMatrix, ticks: 2, memory: '{}', world: spatialWorld },
  { name: 'stores', loop: stores, ticks: 2, memory: '{}', world: spatialWorld },
  // Authentic pinned native path finder: its terrain is process-global, so this scenario always
  // runs alone in its own process (a child process when the whole suite runs).
  {
    name: 'native-paths',
    loop: nativePaths,
    ticks: 3,
    memory: '{}',
    world: spatialWorld,
    native: true,
  },
];
const requested = process.argv.indexOf('--scenario');
if (requested !== -1) {
  const name = process.argv[requested + 1];
  assert.ok(
    scenarios.some((scenario) => scenario.name === name),
    `Unknown scenario ${name}`,
  );
}
const selected =
  requested === -1
    ? scenarios
    : scenarios.filter((scenario) => scenario.name === process.argv[requested + 1]);
let comparisons = 0;
let leaves = 0;
const results = [];
const hostedApiExtensions = [];
function coverageFor(scenario) {
  if (scenario.loop === gameplay)
    return [
      'action validation precedence',
      'observable object properties/enumeration/JSON',
      'generic and resource-specific stores',
      'intent replacement/cancellation/insertion order',
      'legacy first-tick pathfinding and movement',
      'RoomPosition/spatial/map/CostMatrix queries',
      'market views/validation',
      'visuals/event logs',
    ];
  if (scenario.loop === persistence)
    return [
      'segments/public/foreign activation',
      'persistent globals/modules/Memory/console across ticks and code reset',
      'binary module loading',
    ];
  if (scenario.loop === rawMemory)
    return [
      'RawMemory set versus materialized Memory',
      'RawMemory request validation/coercion',
      'segment serialization',
    ];
  if (scenario.loop === memoryJSON)
    return [
      'JSON Memory serialization including toJSON and non-JSON values',
      'segment serialization',
    ];
  if (scenario.loop === positions)
    return [
      'RoomPosition construction/packing/setters/metadata and argument coercion',
      'RoomPosition range/near/equal/direction/cross-room geometry',
      'findInRange/findClosestByRange/look/lookFor and exit finds with per-tick cache aliasing',
      'Room.serializePath/deserializePath malformed input',
      'Room.Terrain get/getRawBuffer bounds/coercion/destinations',
      'pre-native PathFinder.search/findPath/findClosestByPath early returns',
      'RoomPosition/Room/PathFinder globals and positions reused across ticks',
    ];
  if (scenario.loop === legacyPaths)
    return [
      'legacy findPath obstacles/terrain/options/serialization/limits',
      'legacy path cache, positions-set cache and end nodes',
      'legacy findClosestByPath astar/dijkstra and cross-room findPathTo/moveTo',
    ];
  if (scenario.loop === mapRouting)
    return [
      'Game.map describeExits/getRoomStatus/isRoomAvailable/world size',
      'Game.map linear/continuous distance and getTerrainAt/getRoomTerrain',
      'Game.map findRoute/findExit/findExitTo incl. routeCallback coercion, order, receivers, failures',
      'Game.map objects reused across ticks and interleaved route searches',
    ];
  if (scenario.loop === costMatrix)
    return [
      'CostMatrix set/get coercion, bounds and index aliasing',
      'CostMatrix clone/serialize/deserialize incl. malformed input',
      'CostMatrix/PathFinder metadata, foreign receivers and subclassing',
      'CostMatrix reuse from globals/Memory across ticks',
    ];
  if (scenario.loop === stores)
    return [
      'Store capacity/used/free for general, resource-specific and mixed stores',
      'Store proxy reads/enumeration/coercion/writes and lazy _sum caching',
      'Store receivers, detached calls and stores held across ticks',
      'legacy store aliases on structures/creeps',
    ];
  if (scenario.loop === nativePaths)
    return [
      'authentic native PathFinder.search goals/ranges/flee/costs/limits/coercion',
      'native roomCallback matrices/false/foreign shapes/failures/call order and terrain-less rooms',
      'new-pathfinder findPath/findPathTo/findClosestByPath options, costCallback and grid caches',
      'moveTo path computation, visualization and Memory path reuse across ticks',
    ];
  return [
    'parsed Memory root properties/prototype/serialization',
    'Memory-root operation values and exception classes',
  ];
}

// Only absent persistence bookkeeping is dropped by JSON transport. Timing/heap/CPU measurements
// are not selected at all, never coerced to matching fake values. The separately asserted hosted
// shard access extension is removed only at its exact observation path. Everything else is compared.
const transport = (value) => JSON.parse(JSON.stringify(value));
function differing(a, b, path = '$') {
  if (Object.is(a, b)) {
    leaves++;
    return undefined;
  }
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object')
    return { path, upstream: a, local: b };
  if (Array.isArray(a) !== Array.isArray(b)) return { path, upstream: a, local: b };
  const ak = Object.keys(a),
    bk = Object.keys(b);
  if (ak.length !== bk.length || ak.some((key) => !Object.hasOwn(b, key)))
    return { path: `${path}.[keys]`, upstream: ak, local: bk };
  for (const key of ak) {
    const found = differing(a[key], b[key], `${path}.${key}`);
    if (found) return found;
  }
  return undefined;
}
function same(scenario, tick, section, upstream, local) {
  const a = transport(upstream),
    b = transport(local);
  const difference = differing(a, b);
  if (difference) {
    console.error(
      JSON.stringify({
        suite: 'runtime',
        status: 'mismatch',
        scenario,
        tick,
        section,
        ...difference,
      }),
    );
    throw new Error(
      `Differential mismatch: ${scenario} tick ${tick} ${section} ${difference.path}`,
    );
  }
  assert.deepEqual(b, a);
  comparisons++;
}
function intentEnvelope(original) {
  // Engine API's typed wrapper is not the old driver's flat wire object. This is lossless:
  // every non-notify/global key is moved under rooms and every payload/order is retained.
  const result = { rooms: {} };
  for (const [key, value] of Object.entries(original)) {
    if (key === 'notify' || key === 'global') result[key] = value;
    else result.rooms[key] = value;
  }
  return result;
}
function intentOrder(envelope) {
  return Object.entries(envelope.rooms).map(([room, objects]) => ({
    room,
    objects: Object.entries(objects).map(([id, intents]) => ({ id, names: Object.keys(intents) })),
  }));
}
function sharedGameplayMemory(upstream, local, tick) {
  const expected = JSON.parse(upstream);
  const actual = JSON.parse(local);
  assert.equal(
    Object.hasOwn(expected.probe.shard, 'access'),
    false,
    'Pinned private-server Game.shard.access is absent',
  );
  assert.equal(
    Object.hasOwn(actual.probe.shard, 'access'),
    true,
    'Hosted Game.shard.access is present',
  );
  assert.equal(actual.probe.shard.access, true, 'Non-restricted hosted shard grants access');
  hostedApiExtensions.push({
    name: 'Game.shard.access',
    category: 'hosted-api-extension',
    scenario: 'gameplay',
    tick,
    upstream: { present: false },
    local: { present: true, value: true },
  });
  delete actual.probe.shard.access;
  // No other fields or errors are dropped. Re-serialize in original key order so even shared
  // player Memory serialization remains compared after this one explicitly asserted divergence.
  return { upstream, local: JSON.stringify(actual), expected, actual };
}
function saved(state, original) {
  return {
    memory: state.memory,
    segments: state.segments,
    activeSegments: state.activeSegments,
    publicSegments: state.publicSegments,
    defaultPublicSegment: state.defaultPublicSegment,
    activeForeignSegment: state.activeForeignSegment && {
      username: state.activeForeignSegment.username,
      id: state.activeForeignSegment.id,
      userId: original ? state.activeForeignSegment.user_id : state.activeForeignSegment.userId,
    },
  };
}
// Counts player-side `attempt` records (single `value` or `throws` key) inside an observation.
function attemptStats(value, stats = { attempts: 0, values: 0, throws: 0 }) {
  if (!value || typeof value !== 'object') return stats;
  const keys = Object.keys(value);
  if (keys.length === 1 && (keys[0] === 'value' || keys[0] === 'throws')) {
    stats.attempts++;
    stats[keys[0] === 'value' ? 'values' : 'throws']++;
  }
  for (const key of keys) attemptStats(value[key], stats);
  return stats;
}
// Upstream-side sanity checks: the probes must reach the intended original behavior, not just
// agree on vacuous empty results or uniform failures.
function coreAssertions(name, tick, probe) {
  if (name === 'positions') {
    assert.equal(probe.room.exits[0].value.length, 3, 'Top exit gap found by original');
    assert.deepEqual(
      probe.look.terrain.map((entry) => entry.value[0]),
      ['plain', 'wall', 'plain', 'swamp', 'wall', 'swamp', 'wall', 'wall'],
    );
    assert.ok(probe.constructRoom.some((entry) => entry.throws));
    assert.ok(probe.constructRoom.some((entry) => entry.value));
    assert.equal(probe.persist.sameConstructors[0], true, 'RoomPosition global persists');
    assert.equal(probe.persist.sameExitObjects, tick === 1, 'Exit cache is per tick');
  }
  if (name === 'legacy-paths') {
    const lengths = probe.paths.flat().map((entry) => entry.value?.length ?? -1);
    assert.ok(lengths.filter((length) => length > 3).length > 40, 'Legacy A* produced paths');
    assert.ok(probe.findPathTo.crossRoomTop.value.length > 0, 'Cross-room legacy path ran');
    assert.ok(probe.endNodes.dijkstraSources.value.length > 0, 'Legacy Dijkstra ran');
  }
  if (name === 'map') {
    // probe.routes follows the player's pair list: [2] W1N1->W0N1, [5] W1N1->E0N1.
    assert.ok(probe.routes[2].route.value.length > 1, 'Asymmetric exits force a detour');
    assert.equal(probe.routes[5].route.value, -2, 'Isolated room is unreachable');
    assert.ok(probe.calls.length > 3, 'Route callbacks were invoked');
    assert.deepEqual(
      [...new Set(probe.status.map((entry) => entry.value?.status).filter(Boolean))].sort(),
      ['closed', 'normal', 'novice', 'respawn'],
    );
  }
  if (name === 'cost-matrix') {
    assert.ok(probe.serialized.nonZero.length > 10, 'Matrix cells were written');
    assert.ok(
      probe.deserialize.some((entry) => entry.throws),
      'Malformed deserialize fails',
    );
    assert.deepEqual(probe.persist.cells, tick === 1 ? [70, 0] : [70, 80]);
  }
  if (name === 'stores') {
    assert.equal(Object.keys(probe.objects).length, 18);
    assert.ok(
      Object.values(probe.objects).every((entry) => entry.value),
      'All object stores probed',
    );
    assert.equal(probe.objects.lab.value.methods.getCapacity[5].value, 3000);
  }
  if (name === 'native-paths') {
    const single = probe.search.single.value;
    assert.ok(single.path.length > 0 && single.ops > 0, 'Authentic native search ran');
    assert.equal(probe.search.callbackThrows.throws.message, 'room callback failure');
    assert.ok(probe.findPath.plain.value.length > 0, 'Native-backed findPath ran');
    if (tick > 1) assert.equal(typeof probe.move.reuseBefore.path, 'string', 'Path reused');
  }
}

// Runs one native-backed scenario alone in a child process and merges its verified summary.
function isolatedNativeRun(scenario) {
  const child = spawnSync(
    process.execPath,
    [fileURLToPath(import.meta.url), '--scenario', scenario.name],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (child.status !== 0) {
    process.stdout.write(child.stdout);
    process.stderr.write(child.stderr);
    throw new Error(`Native-backed scenario ${scenario.name} failed in its isolated process`);
  }
  const summary = JSON.parse(child.stdout.trim().split('\n').at(-1));
  assert.equal(summary.status, 'passed');
  comparisons += summary.comparisons;
  leaves += summary.matchingLeaves;
  hostedApiExtensions.push(...summary.hostedApiExtensions);
  results.push(...summary.scenarios.map((result) => ({ ...result, process: 'isolated-native' })));
}

for (const scenario of selected) {
  if (scenario.native && selected.length > 1) {
    isolatedNativeRun(scenario);
    continue;
  }
  const world = fixture();
  scenario.world?.(world);
  const runtime = new BotRuntime({ now: () => NOW });
  let oracle;
  try {
    oracle = await createRuntimeOracle({
      now: NOW,
      ...(scenario.native ? { nativeTerrain: world.terrain } : {}),
    });
    const modules = playerModules(scenario.loop);
    runtime.setCode('u1', modules);
    oracle.setCode('u1', modules);
    runtime.setMemory('u1', scenario.memory);
    oracle.setMemory('u1', scenario.memory);
    runtime.setSegment('u1', 4, 'seed-segment');
    oracle.setSegment('u1', 4, 'seed-segment');
    if (scenario.name === 'persistence') {
      const bob = {
        main: 'module.exports.loop = () => { RawMemory.segments[7] = "public-bob"; RawMemory.setPublicSegments([7]); RawMemory.setDefaultPublicSegment(7); };',
      };
      runtime.setCode('u2', bob);
      oracle.setCode('u2', bob);
    }
    let validationCases = 0;
    const probeStats = { attempts: 0, values: 0, throws: 0 };
    for (let tick = 1; tick <= scenario.ticks; tick++) {
      if (scenario.name === 'persistence') {
        const bobLocal = await runtime.runUser(world, 'u2');
        const bobOriginal = await oracle.run(world, 'u2');
        assert.ok(bobLocal);
        assert.equal(bobOriginal.type, 'done');
        assert.equal(bobLocal.console.error, undefined);
        same(
          scenario.name,
          tick,
          'foreign-publisher',
          saved(bobOriginal.persistent, true),
          saved(runtime.snapshot().users.u2, false),
        );
        if (tick === 4) {
          runtime.setCode('u1', modules);
          oracle.setCode('u1', modules);
        }
        runtime.enqueueConsoleCommand(
          'u1',
          'Memory.consoleTicks = (Memory.consoleTicks || 0) + 1; Memory.consoleTicks',
        );
        oracle.enqueueConsoleCommand(
          'u1',
          'Memory.consoleTicks = (Memory.consoleTicks || 0) + 1; Memory.consoleTicks',
        );
        runtime.enqueueConsoleCommand('u1', '99', true);
        oracle.enqueueConsoleCommand('u1', '99', true);
      }
      const original = await oracle.run(world, 'u1');
      const local = await runtime.runUser(world, 'u1');
      assert.ok(local, `${scenario.name}: local player ran`);
      // A player exception is a failed probe, not a matching empty result.
      assert.equal(original.type, 'done', `Oracle player failed: ${original.error}`);
      assert.equal(local.console.error, undefined, `Local player failed: ${local.console.error}`);
      same(scenario.name, tick, 'intents', intentEnvelope(original.intents), local.intents);
      same(
        scenario.name,
        tick,
        'intent-insertion-order',
        intentOrder(intentEnvelope(original.intents)),
        intentOrder(local.intents),
      );
      if (scenario.loop === invalidMemory) {
        assert.equal(original.console.log.length, 1);
        assert.equal(local.console.log.length, 1);
        // Parsed first so a mismatch names the exact Memory-root probe path (messages included).
        same(
          scenario.name,
          tick,
          'memory-root-observations',
          JSON.parse(original.console.log[0].message),
          JSON.parse(local.console.log[0].message),
        );
      }
      same(scenario.name, tick, 'console', original.console, local.console);
      same(scenario.name, tick, 'visual', original.visual ?? {}, local.visual);
      let localMemory = runtime.getMemory('u1');
      if (scenario.name === 'gameplay') {
        const shared = sharedGameplayMemory(original.memory, localMemory, tick);
        same(scenario.name, tick, 'player-observations', shared.expected, shared.actual);
        localMemory = shared.local;
      } else if (scenario.name === 'persistence' || scenario.world) {
        same(
          scenario.name,
          tick,
          'player-observations',
          JSON.parse(original.memory),
          JSON.parse(localMemory),
        );
      }
      same(
        scenario.name,
        tick,
        'persistent-state',
        saved(original.persistent, true),
        saved({ ...runtime.snapshot().users.u1, memory: localMemory }, false),
      );
      if (scenario.name === 'gameplay') {
        const memory = JSON.parse(original.memory);
        validationCases = Object.keys(memory.probe.records).length;
        assert.ok(validationCases > 140, 'Validation matrix must actually execute');
        assert.equal(
          original.intents.W1N1.worker.move.direction,
          7,
          'Final move replaces earlier calls and canceled intent',
        );
        assert.equal(
          original.intents.W1N1.worker.say.message,
          'last',
          'Final say replaces first call',
        );
        assert.equal(
          original.intents.W1N1.worker.drop.resourceType,
          'H',
          'Final drop replaces earlier resource',
        );
        assert.ok(
          memory.probe.positions.path.length > 0,
          'Original legacy pathfinding actually ran',
        );
      }
      if (scenario.name === 'persistence') {
        const observations = JSON.parse(original.memory).observations;
        assert.equal(observations.length, tick);
        assert.equal(
          observations.at(-1).turns,
          tick === 4 ? 1 : tick,
          'Persistent global resets only after code changes',
        );
        assert.equal(observations.at(-1).memory, tick, 'Serialized Memory survives code reset');
        assert.equal(observations.at(-1).loads, 1, 'Module executed once per isolate');
        if (tick > 1) {
          assert.equal(observations.at(-1).segments[3], `segment-${tick - 1}`);
          assert.equal(observations.at(-1).foreign.data, 'public-bob');
        }
      }
      if (scenario.world) {
        const probe = JSON.parse(original.memory).probe;
        const stats = attemptStats(probe);
        assert.ok(
          stats.values > 0 && stats.throws > 0,
          `${scenario.name}: probes must exercise values and errors`,
        );
        for (const key of Object.keys(probeStats)) probeStats[key] += stats[key];
        coreAssertions(scenario.name, tick, probe);
      }
      if (scenario.name === 'raw-memory')
        assert.equal(
          original.memory,
          '{"replaced":true}',
          'RawMemory.set wins over stale materialized Memory',
        );
      world.gameTime++;
      world.roomObjects.worker.x++;
    }
    results.push({
      scenario: scenario.name,
      ticks: scenario.ticks,
      ...(validationCases ? { validationCases } : {}),
      ...(probeStats.attempts ? { probes: probeStats } : {}),
    });
  } finally {
    runtime.dispose();
    oracle?.dispose();
  }
}
console.log(
  JSON.stringify({
    suite: 'runtime',
    status: 'passed',
    oracle:
      'pinned original game + driver runtime/data modules (original module sources in webpack-style wrappers) in constrained adapter; native-paths uses the authentic pinned native path finder addon in an isolated process',
    source: 'src/runtime/index.ts (native Node TypeScript; runtime bundle from src)',
    scenarios: results,
    comparisons,
    matchingLeaves: leaves,
    coverage: [...new Set(selected.flatMap(coverageFor))],
    exclusions: [
      'native PathFinder search in non-native scenarios (failing stub; only native-paths loads the authentic addon) and native CPU/heap/termination parity',
      'full upstream server/DB/queue scheduling and CPU bucket accounting',
      'official-only account/InterShardMemory extensions absent in pinned private-server runtime',
      'legacy path queries after first tick (upstream PathFinder.use closes over the initial register)',
    ],
    normalization: [
      'lossless upstream flat room intents -> typed rooms envelope; global/notify and all payloads retained',
      ...(hostedApiExtensions.length
        ? [
            'separately asserted hosted Game.shard.access removed only at $.probe.shard.access when comparing shared observed/serialized Memory',
          ]
        : []),
      'JSON transport drops undefined persistence bookkeeping; identical player code performs its own JSON serialization',
      'host clock and player Date.now fixed; player Math.random seeded; shard hostname replaced with identical fixture shard name',
      'timing/CPU/heap measurements excluded, not masked',
    ],
    expectedSafetyDivergences: [],
    hostedApiExtensions,
  }),
);
