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
  terrain edits; this updates existing player isolates without a global reset.
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

The checked-in suite has 34 deterministic tests covering embedding, state
restoration, gameplay boundaries, markets, powers, runtime isolation, CPU
accounting, callable constructors, and shard access.

During implementation, 28 differential scenarios matched the pinned reference,
including a 40-tick two-player economy, combat, spawning, NPCs, structures,
room transitions, markets, player API return codes, and memory segments. That
comparison used an in-memory storage adapter, normalized generated IDs and
timing-related bookkeeping, and excluded the added hosted-game APIs from the
standalone API-surface comparison. It does not establish equivalence of upstream
parallel-runner races.

A separate native-pathfinder comparison matched 240 seeded cases exactly for
path, cost, operation count, and incomplete status. A native cross-room
tie-breaking/operation-limit case is retained in the checked-in tests.
