import assert from 'node:assert/strict';
import { BotRuntime } from '../src/runtime/index.ts';
import { verifyReferences } from './references.mjs';
import { createRuntimeOracle } from './runtime/oracle.mjs';
import { fixture, NOW } from './runtime/fixture.mjs';
import {
  playerModules,
  gameplay,
  persistence,
  rawMemory,
  invalidMemory,
  memoryJSON,
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
const excludedDimensions = [];
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
function memoryRootConsole(upstream, local, scenario, tick) {
  const expected = structuredClone(upstream);
  const actual = structuredClone(local);
  assert.equal(expected.log.length, 1);
  assert.equal(actual.log.length, 1);
  const a = JSON.parse(expected.log[0].message),
    b = JSON.parse(actual.log[0].message);
  for (const operation of ['keys', 'creep', 'room']) {
    if (a[operation]?.name === 'TypeError' && b[operation]?.name === 'TypeError') {
      assert.equal(typeof a[operation].message, 'string');
      assert.equal(typeof b[operation].message, 'string');
      excludedDimensions.push({
        dimension: 'native-error-wording',
        scenario,
        tick,
        operation,
        upstream: a[operation].message,
        local: b[operation].message,
      });
      delete a[operation].message;
      delete b[operation].message;
    }
  }
  // Compare the parsed probe separately for precise differences, including parsed Memory, raw
  // contents, successful values and exception classes. Only native TypeError prose is omitted.
  same(scenario, tick, 'memory-root-observations', a, b);
  expected.log[0].message = JSON.stringify(a);
  actual.log[0].message = JSON.stringify(b);
  return { expected, actual };
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

for (const scenario of selected) {
  const world = fixture();
  const runtime = new BotRuntime({ now: () => NOW });
  let oracle;
  try {
    oracle = await createRuntimeOracle({ now: NOW });
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
        const shared = memoryRootConsole(original.console, local.console, scenario.name, tick);
        same(scenario.name, tick, 'console', shared.expected, shared.actual);
      } else {
        same(scenario.name, tick, 'console', original.console, local.console);
      }
      same(scenario.name, tick, 'visual', original.visual ?? {}, local.visual);
      let localMemory = runtime.getMemory('u1');
      if (scenario.name === 'gameplay') {
        const shared = sharedGameplayMemory(original.memory, localMemory, tick);
        same(scenario.name, tick, 'player-observations', shared.expected, shared.actual);
        localMemory = shared.local;
      } else if (scenario.name === 'persistence') {
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
    oracle: 'pinned original game + driver runtime/data modules in constrained adapter',
    source: 'src/runtime/index.ts (native Node TypeScript; runtime bundle from src)',
    scenarios: results,
    comparisons,
    matchingLeaves: leaves,
    coverage: [...new Set(selected.flatMap(coverageFor))],
    exclusions: [
      'upstream native PathFinder search and native CPU/heap/termination parity',
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
      ...(excludedDimensions.length
        ? [
            'native TypeError prose omitted only from root keys/creep/room probe errors; exact both-side diagnostics reported separately',
          ]
        : []),
      'JSON transport drops undefined persistence bookkeeping; identical player code performs its own JSON serialization',
      'host clock and player Date.now fixed; player Math.random seeded; shard hostname replaced with identical fixture shard name',
      'timing/CPU/heap measurements excluded, not masked',
    ],
    expectedSafetyDivergences: [],
    hostedApiExtensions,
    excludedDimensions,
  }),
);
