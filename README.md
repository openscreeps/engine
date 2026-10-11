# OpenScreeps engine

A TypeScript port of the Screeps game engine for in-process simulation and bot integration.
The pinned source references and licenses are in `reference-versions.json` and
`THIRD_PARTY_NOTICES.md`. This is an engine library, not an HTTP server or game client.

## Development

```sh
mise install
mise run install
mise run check
```

Mise pins Node 24.21.0. `npm run check` runs strict TypeScript checking, type-aware
ESLint, Prettier verification, the behavioral tests, and the declaration build.
`npm run format` applies formatting. The package uses ESM and exports built code
from `dist/index.js`; source tests run with Node's native TypeScript support.
The `prepare` lifecycle builds `dist` when packing or installing from Git, so a
pinned Git dependency does not rely on generated files being committed.

## Embed a world

After building, import `Engine` and `createWorldState` from `@openscreeps/engine`
(or from `./dist/index.js` when running in this checkout).

```js
import { Engine, createWorldState } from './dist/index.js';

const world = createWorldState({
  gameTime: 1,
  rooms: { W1N1: { _id: 'W1N1', status: 'normal' } },
  terrain: { W1N1: '0'.repeat(2500) },
  activeRooms: ['W1N1'],
  users: { alice: { _id: 'alice', username: 'Alice', cpu: 100, cpuAvailable: 10000 } },
  roomObjects: {
    worker: {
      _id: 'worker',
      type: 'creep',
      name: 'Worker',
      user: 'alice',
      room: 'W1N1',
      x: 11,
      y: 10,
      body: [
        { type: 'work', hits: 100 },
        { type: 'carry', hits: 100 },
        { type: 'move', hits: 100 },
      ],
      hits: 300,
      hitsMax: 300,
      store: { energy: 0 },
      storeCapacity: 50,
      fatigue: 0,
      ageTime: 1501,
      spawning: false,
      actionLog: {},
    },
    source: {
      _id: 'source',
      type: 'source',
      room: 'W1N1',
      x: 10,
      y: 10,
      energy: 3000,
      energyCapacity: 3000,
      nextRegenerationTime: null,
    },
  },
});

using engine = new Engine(world);
engine.setCode('alice', {
  main: `module.exports.loop = function () {
    Memory.ticks = (Memory.ticks || 0) + 1;
    Game.creeps.Worker.harvest(Game.getObjectById('source'));
  };`,
});
const result = await engine.tick();
if (result.runtime.users.alice.console.error) {
  throw new Error(result.runtime.users.alice.console.error);
}
if (result.simulation.errors.length) {
  throw new Error(JSON.stringify(result.simulation.errors));
}
console.log(engine.snapshot().world.roomObjects.worker.store.energy); // 2
console.log(engine.getMemory('alice')); // {"ticks":1}
```

`Engine.tick()` runs eligible players against the current tick's world, collects
intents, resolves room and global processing, then advances game time. It rejects
overlapping calls. Player exceptions are reported in the runtime result; room
processing errors are reported in the simulation result. Check both.

`Engine.processIntents(intents, manualIntents?)` advances the simulation without
executing player code. Use the exported `storeIntents(flatIntents, lookupRoom)` to
sanitize and group raw intents into a user's room/global buckets. `Simulation`
and `BotRuntime` are separately exported when the embedder needs to control those
phases itself.

As in the reference runner, `tick()` selects users with a positive CPU allocation
and `active !== 0`. Direct `BotRuntime.runUser()` is available for explicit runner
control. Its `cpu.used` is the reported usage; `cpu.charged` is the independently
calculated bucket debit. Unlimited CPU values are `Infinity`, which ordinary JSON
serialization turns into `null`.

## State and lifetime

- Constructors copy their input state by default; snapshots do not share mutable
  state with the running engine. The engine has no database or network dependency.
- A serialized server can opt into `new Simulation(world, { stateOwnership: 'shared' })`
  to process its canonical world without copying it each tick. The host must not
  mutate that world during a tick. Call `simulation.refreshTerrain()` after adding,
  removing, or editing room terrain. Between-tick maintenance can advance `world.rngState`;
  the simulation resumes from that state on its next tick.
  When hosting `BotRuntime` separately, also call `runtime.refreshTerrain()` after
  terrain edits; this updates existing player isolates, PathFinder terrain and map
  exits without a global reset. Added or removed rooms invalidate the terrain pack
  automatically; removed rooms no longer retain player-side terrain caches.
  `runtime.removeUser(userId)` releases a retired user's isolate and persistent
  runtime data.
- `engine.snapshot()` contains the world plus persistent runtime data.
  `Engine.restore(snapshot, options)` restores a separate engine. JavaScript heap
  globals are not serialized: restoring performs a global reset while preserving
  code, memory, and other persistent runtime state.
- Call `dispose()` when finished, or use Node 24's `using` declarations.
- Simulation randomness is instance-local and stored in the world snapshot.
  Supply `simulation.now` and `runtime.now` when a scenario needs controlled
  engine wall-clock inputs. Player `Date`/`Math.random` and CPU measurements are
  still sources of nondeterminism; replay recorded intents to isolate game rules.
- `SimulationOptions.hooks` exposes typed per-instance processing hooks. History
  and statistics are returned as data, rather than sent to a storage service.
- Multi-shard worlds can share an exported `InterShardStore` through
  `runtime.interShard`. This supplies inter-shard memory and per-account shard CPU
  allocation. It does not provide network transport.
- Runtime custom object prototypes and intent schemas are configured with
  `runtime.customObjectPrototypes` and `runtime.customIntentTypes`. Processing
  custom intents belongs in the simulation hooks, not in a second simulation.
  A prototype extender retains a live scope whose runtime data, registries and
  intent recorder are refreshed each tick; custom methods continue to work
  without resetting the player's globals.
- `runtime.playerSandbox(sandbox, userId)` is the driver `playerSandbox` mod
  event: it runs synchronously every run after `Game` is prepared and before
  player code, unbilled, with `run`/`set`/`get`/`getIsolate`/`getContext`/
  `getGlobal`. These handles stay on the host; a throwing hook fails that
  player's run. Synchronous hook time does not consume other players' host
  watchdogs, and hook calls into player-controlled globals retain V8 timeouts.
  `runtime.getAllUsers(eligible)` returns the ids of the eligible users to run,
  like overriding driver `getAllUsers`.
- Server mods' constant changes (upstream `config.common.constants`) are
  per world: mutate a `createConstants()` copy and pass it as
  `EngineOptions.constants` (or `SimulationOptions.constants` and
  `runtime.constants`). The simulation and every player isolate read that
  object; other worlds in the process keep their own values, and the exported
  `constants` stay the immutable defaults. `worldConstants(world)` returns the
  constants a simulation bound to its world. String identifiers (structure,
  resource, body part, look and order types) and `TERRAIN_MASK_*` name or
  encode persisted data and are rejected if changed, rather than silently
  reinterpreting existing worlds.

## Worker processes

By default player isolates and room processing run in the embedding process.
The original launcher topology is available as two supervised process pools,
owned and closed (`await pool.close()`) by the host and passed to any number of
engines:

- `new RunnerPool({ processes, threads })` (launcher `runners_cnt`,
  `runner_threads`) hosts player isolates; pass it as `runtime.runners`. All
  accounting (CPU bucket, memory, segments, console, intents) stays in the
  embedding process. Each player keeps one runner, so its globals live across
  ticks; unlike several original runner processes, a player never has two
  global environments. A runner that dies fails its in-flight runs like crashed
  scripts (nothing saved) and is restarted; its players reset globals on their
  next run.
- `new ProcessorPool({ processes })` (launcher `processors_cnt`) processes rooms;
  pass it as `simulation.processors` and advance with `await simulation.tickAsync()`
  (`Engine.tick()` does). Rooms are read from the stage-start world and processed
  concurrently with private random streams; their recorded writes are applied in
  queue order after every room finished, then the global stage runs. The world is
  untouched until then, so a closed pool rejects the tick without changes. A room
  whose processor dies is retried once, then reported as a room error. Like the
  original's concurrent processors, cross-room effects within a tick (for example
  a nuke launched into a room processed later) and random draws differ from the
  deterministic in-process order, which stays the default and the conformance
  reference.
- `restartIntervalMs` (launcher `restart_interval`) replaces each process
  periodically after it finished its work in flight. `setup: { module, data }`
  names a module loaded in every worker process whose default export
  `(data, kind, host)` returns `{ playerSandbox }` (runners) or `{ hooks }`
  (processors); functions never cross processes, so these replace the in-process
  `runtime.playerSandbox` and `simulation.hooks`. `host.call()` reaches the pool's
  `onCall` handler, and `pool.broadcast(event, data)` reaches `host.on(event)`.
  `onEvent` reports process start, exit, restart and (with `output: 'events'`)
  output. Workers exit when the embedding process disconnects.
  Workers inherit the host's module-loader flags, not its test/eval/inspector
  arguments, so source-mode hosts can load TypeScript setup modules too.

## Runtime boundary

Player code executes in `isolated-vm`, in a separate V8 isolate per player. The
player API is bundled into that isolate so objects, arrays, prototypes, and bot
modifications belong to the player's realm. Heap limits and execution deadlines
are enforced by the runtime. An isolate is not an operating-system process;
production hosting should additionally contain the Node process and its resources.
Host-side intent routing uses own data properties for destination dictionaries:
untrusted room and object names cannot reuse or modify inherited host properties.

The runtime bundles the upstream-compatible Lodash and Buffer versions for bot
compatibility. Native dependencies can require a supported prebuilt binary or a
working native build toolchain on the target platform.

## Engine versus server

The embedder supplies world data and schedules ticks. This package does not
implement the official client's transport protocol, authentication, persistence,
shard orchestration, or backend cron jobs. In particular, periodic room activation,
NPC world generation, market-statistics aggregation, and notification delivery
remain server responsibilities. Market history is supplied through world state.

Account resources and grants are embedding inputs. Restricted-shard state uses
`world.restrictedShard`, `user.shardAccessTime`, and `user.shardAccessUnlimited`;
CPU subscription/unlock state uses `user.cpuSubscription` and
`user.cpuUnlockedTime`. The engine processes access-key activation, CPU-unlock
consumption, and pixel generation. Billing and the account service that computes
the user's assigned CPU allowance are outside this library. Market history reads
`world.marketStats`.

The shard documentation gives both an unrestricted-shard error code and ambiguous
method-availability wording for `activateAccess()`. This implementation exposes
the method on all shards and returns `ERR_INVALID_TARGET` on unrestricted ones.

Compatibility is checked against the pinned public sources; it is not a claim of
certified equivalence to every private configuration of the hosted MMO. Timing,
external-service policy, and server-provided world inputs must be considered when
comparing runs. New document IDs are deterministic 24-digit hexadecimal values.
Function source text, stack traces, and some V8-generated TypeError wording differ
from the original JavaScript source.

## Verification

`npm run check` runs the checked-in behavioral tests, strict TypeScript, lint,
formatting and the declaration build.

The differential suite executes the original public JavaScript sources pinned in
`reference-versions.json`, not a second implementation of expected game rules:

```sh
npm run conformance:setup
npm run conformance
```

Setup clones missing references under `.reference/` and installs their locked
JavaScript dependencies with lifecycle scripts disabled. It refuses changed
tracked source or a different checkout revision. It also builds the pinned C++
pathfinder with its locked `nan`/`node-gyp` toolchain, without installing the old
driver's isolated-vm fork. This requires Python 3 and a C++20 build toolchain
(MSVC on Windows; make/g++ on Ubuntu), plus network access for packages and Node
headers. CI runs setup and conformance on Windows and Ubuntu.

`conformance/runtime.mjs` compares player observations, intents and memory using
the original runtime/game code through a constrained host adapter.
`conformance/simulation.mjs` compares multi-tick results from the original
processor against `Simulation`. Each runner reports its exercised coverage,
reference revisions, differences and normalization. An unexpected mismatch exits
nonzero; a passing run establishes equivalence only for its scenarios.

`conformance/pathfinder.mjs` compares the pinned driver wrapper and native addon
against the TypeScript pathfinder: exact paths, operation counts, costs,
completion, errors, callback ordering and argument coercion. The default run
combines 173 fixed cases with 1,000 seeded cases. A missing or stale native oracle
fails the suite; it is never replaced by a local implementation.

```sh
npm run conformance:pathfinder -- --seeds 10000 --start 800000
npm run conformance:pathfinder -- --seed 800123
```

`npm run conformance:cpu` compares artificial intent CPU exactly using real player
runtimes with the measured CPU clock frozen to zero. It covers replacement,
cancellation, free/failed actions, appended intent caps and per-tick reset.
Elapsed-time billing, host bucket debits and timeout policy are separate limits;
see [CONFORMANCE.md](CONFORMANCE.md). The default conformance command includes it.

`npm run conformance` uses independent processing order and permits only the
named, two-sided assertions listed in [CONFORMANCE.md](CONFORMANCE.md).
`npm run conformance:strict` also fails on these retained differences.
`npm run conformance:controlled` is a diagnostic with oracle order replayed; it
does not establish independent ordering equivalence.

The compatibility policy is **preserve safety and completed functionality, match
gameplay**. Ordinary historical gameplay quirks are compatibility requirements.
Security protections and working replacements for upstream TODOs/crashes may
diverge only through explicit, narrowly checked cases reported separately.
Infrastructure adapters must not implement the game rules being compared or
discard semantic differences.

These suites do not prove private MMO parity, hardware-independent CPU timing,
exhaustive pathfinder equivalence, or upstream parallel-runner race behavior.
Backend/world comparisons live in `@openscreeps/game`'s conformance suite.

The runtime report separately identifies the hosted-only `Game.shard.access`
extension, absent from the standalone reference. It compares shared fields and
asserts the precise extension rather than claiming identical API surfaces.
Malformed-memory probes now compare error messages as well as classes, failing
operations and resulting state. The oracle preserves upstream modules' original
strict/sloppy mode. Native-backed runtime scenarios run in isolated processes to
avoid contamination from the native addon's process-global terrain cache.

See [CONFORMANCE.md](CONFORMANCE.md) for retained differences, reproductions,
linked defect tickets and the distinction between independent and controlled
processing-order comparisons.
