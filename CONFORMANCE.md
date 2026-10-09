# Conformance boundaries and tracked divergences

Policy: preserve safety and existing completed functionality; match ordinary
upstream gameplay behavior. An expected divergence is not a matching result.
The commands below execute pinned original sources after `npm run conformance:setup`.
Reference revisions are recorded in `reference-versions.json` and runner output.

## Runtime

| Case                | Upstream behavior                          | Local behavior and decision                                                                                                                                                               | Tracking                                                   |
| ------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `Game.shard.access` | Absent from the pinned standalone runtime. | Retain the hosted-game API. The unrestricted fixture asserts an own property with value `true`; compare every shared shard field separately. This is not proof of hosted MMO equivalence. | [engine#1](https://github.com/openscreeps/engine/issues/1) |

Reproduce the extension comparison with `node conformance/runtime.mjs --scenario gameplay`.
The report separates `hostedApiExtensions` from shared comparisons.

The expanded runtime suite covers 17 scenarios: spatial queries and RoomPosition
coercion, terrain, path serialization, legacy pathfinding, map routing/status,
CostMatrix, stores, Memory, and native-backed pathfinding. `native-paths` runs in
its own process and loads the authentic addon inside the player isolate; its
three ticks exercise PathFinder, room path APIs and `moveTo` path reuse. Other
scenarios fail explicitly if they reach an unconfigured native search.

The oracle preserves each upstream module's original source and strict/sloppy
mode in separate wrappers. The previous esbuild output inadvertently forced
sloppy modules into strict mode and renamed identifiers near direct eval.
Correcting the oracle exposed primitive-Memory differences previously hidden by
that adapter. The local memory accessors now preserve upstream's silent failed
assignments on primitive roots and its null-root errors. The former diagnostic
exclusion ([engine#3](https://github.com/openscreeps/engine/issues/3)) is removed:
the exercised Memory errors now compare exactly, including messages.

Additional corrected defects: boxed-string paths now deserialize as upstream,
and RoomPosition accepts the same duck-typed room names. Reproduce with
`--scenario legacy-paths`, `--scenario positions`, and `--scenario memory-root-number`.

## Corrected runtime defect

[engine#2](https://github.com/openscreeps/engine/issues/2): parsing
`{"__proto__":{"kept":true},"seed":1}` previously preserved the own property's
object value and cleared the actual root prototype. The original assigns `null`
to that own property while retaining the player-realm prototype. The correction
uses property-assignment semantics inside the isolate, without mutating a shared
or host prototype. `memory-root-own-proto` compares both the property value and
actual prototype classification, plus persistence. A failing-before and
passing-after run was observed; the issue tracks publication status.

## Native pathfinding

`node conformance/pathfinder.mjs` executes the pinned driver's `lib/path-finder.js`
and compiled native addon against `src/utils/pathfinder.ts`. It compares exact
ordered paths, `ops`, `cost`, `incomplete`, result keys, errors, callback order,
argument coercion and nested searches. Inputs are independently materialized on
each side. Native terrain persists process-wide, so each case reloads the same
fixed room set on both sides rather than accidentally retaining extra oracle rooms.

The default suite contains 173 fixed cases and 1,000 deterministic seeded cases:
room and world boundaries, ties, walls/swamps, matrices, multiple goals and
ranges, flee, search limits, malformed inputs, callbacks and repeated searches.
Use `--seeds N --start S` for a larger run or `--seed S` to replay a random case.
Missing/stale native builds fail closed; run `npm run conformance:setup` with
Python 3 and a C++20 build toolchain to build the pinned addon.

The initial expanded comparison exposed two corrected port defects:

- Goal-array traversal skipped sparse entries and made extra observable property
  reads. It now follows the original lodash 3 traversal, including sparse entries.
- Falsy, non-undefined room callbacks were silently disabled. They now fail when
  upstream attempts to invoke them, preserving terrain-error precedence and the
  already-at-goal short circuit.

This is not exhaustive pathfinding proof. Process-terminating native heap errors,
CPU termination and malformed terrain encodings above 3 are not exercised.
The runtime's host-triggered removal of cached terrain is outside this comparison.

## Simulation

The simulation runner executes the pinned original main loop and room processor
against the original storage server over its TCP RPC client. It compares state,
event logs, map views, history, room statistics, errors and RNG state each tick.
The runner supplies intents; player code is exercised separately by the runtime
runner. Native pathfinding is not substituted with a fake successful result:
unsupported native searches throw.

| Case                            | Original behavior                                                                                                                     | Local behavior and policy                                                                                                                            | Tracking                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `storage-dotted-inc`            | Intershard trades increment literal `resources.pixel` keys while leaving the nested balance unchanged, duplicating account resources. | Preserve correct nested accounting. Assert exact balances and corresponding logs on both sides; report the safety difference separately.             | [engine#5](https://github.com/openscreeps/engine/issues/5) |
| `money-log-date-representation` | Dates pass through JSON RPC as ISO strings.                                                                                           | Keep numeric epoch milliseconds internally. Accept only pairs representing the exact same instant; the server serializes dates at its HTTP boundary. | [engine#6](https://github.com/openscreeps/engine/issues/6) |

The independent baseline exposed storage-order differences: rampart `hitsMax`
was 300000 upstream versus 0 locally after a same-tick downgrade; two rooms
received swapped mineral density rolls. [engine#4](https://github.com/openscreeps/engine/issues/4)
tracks the correction: persisted object write sequences reproduce Loki room-index
order, and rooms use the original LIFO queue. The independently run comparison
now has 19 matching scenarios and 2 named divergences across 132 ticks, with no
unexpected mismatches or processing-order differences. Four scenarios reconstruct
the simulation from its own JSON snapshot mid-run. No oracle order is replayed
in this independent mode.

`node conformance/simulation.mjs` is the strict independent comparison.
`--controlled-order` is an additional diagnostic that replays the oracle's
per-room order, marks that intervention in the report, and checks that it was
applied. `--allow-known-divergences` changes only the exit policy for narrowly
asserted named differences; it never converts their status into a match.
Unexplained mismatches, execution errors and vacuous coverage always fail.

### Host-written objects

After changing or inserting a room object outside `Simulation`, call
`recordRoomObjectWrite(world, id)`. For a batch, call
`recordRoomObjectWrites(world, ids)` once, yielding IDs in the actual write order.
Each helper first reconciles existing objects, then records the specified writes;
the batch costs O(room objects + writes), rather than scanning the world per write.
Removals need no call. Unrecorded inserts are discovered at the next helper call
or tick; unrecorded updates cannot reproduce database write ordering.
Game domain/world operations perform this bookkeeping. Hosts editing raw world
state must do the same. Preserve `roomObjectWriteSeq` and `writeSeq` in snapshots;
older snapshots without them initialize ordering from their object key order.

## Limits

The runtime oracle uses original driver runtime/data and game code in a constrained
host adapter. CPU/heap/termination behavior, parallel scheduling and hosted-only
account/inter-shard services are not proven equivalent. Legacy pathfinding
comparisons cover first-tick queries; the native-backed runtime scenario covers
three ticks. Accessor-defined Memory sections, `Game.map.visual`, and webpack's
process polyfills are not covered. Matching this suite does not establish full
game parity or exact function source/stack-trace identity.
