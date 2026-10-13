/*
 * Runs a scenario through the local `Simulation`, one tick at a time, with the users the oracle's runner
 * saved intents for, in the same order (upstream runner threads race; the oracle's single runner thread
 * fixes one order). The local processing order of each room's objects is recorded through the
 * `processObject` hook.
 *
 * By default the local Simulation derives processing order itself (room objects most recently written
 * first, rooms popped LIFO), as an embedding host would. Diagnostic `--controlled-order` mode instead
 * imposes the oracle's observed order before every tick: each room's objects get fresh write sequence
 * numbers in the oracle's order, and the active rooms are arranged so the LIFO queue pops them in the
 * oracle's room order. Generated ids are translated through the comparator's pairing.
 */
import { Simulation } from '../../src/simulation/index.ts';
import { storeIntents } from '../../src/utils/system.ts';
import { createRequire } from 'node:module';
import type { Shared } from './shared.cts';
import type { WorldState } from '../../src/simulation/state.ts';
import type { StoredUserIntents } from '../../src/utils/system.ts';
import type { LocalIdOf, ProcessingOrder, RawIntents, Scenario, TickRecord } from './types.ts';
import { required } from '../assert.ts';

const shared = createRequire(import.meta.url)('./shared.cts') as Shared;

const { createResolver, clockAt } = shared;

function imposeObjectOrder(state: WorldState, order: ProcessingOrder, localIdOf: LocalIdOf) {
  const seqs = (state.roomObjectWriteSeq ??= {});
  let seq = state.writeSeq ?? 0;
  // Same treatment of unsequenced objects as the Simulation, so the imposed numbers stay the newest.
  for (const id of Object.keys(state.roomObjects)) if (!Object.hasOwn(seqs, id)) seqs[id] = ++seq;
  for (const [room, oracleIds] of Object.entries(order)) {
    const ids = oracleIds
      .map(localIdOf)
      .filter((id): id is string => id !== undefined && state.roomObjects[id]?.room === room);
    for (let i = ids.length - 1; i >= 0; i--) seqs[required(ids[i])] = ++seq;
  }
  state.writeSeq = seq;
}

/**
 * `scenario.restartLocalBefore`: tick indexes before which the local Simulation is recreated from its
 * own snapshot (persistence continuity of processing order, ids and random state).
 */
export function createLocalRunner(scenario: Scenario, { controlledOrder = false } = {}) {
  let objectOrder: ProcessingOrder = {};
  const create = (world: WorldState): Simulation => {
    const created: Simulation = new Simulation(world, {
      now: () => clockAt(scenario, created.state.gameTime),
      recordHistory: true,
      hooks: {
        processObject(object) {
          (objectOrder[object.room] ??= []).push(object._id);
        },
      },
    });
    return created;
  };
  let simulation = create(scenario.world);
  return {
    step(
      index: number,
      oracleTick: Pick<TickRecord, 'savedUsers'> & Partial<Pick<TickRecord, 'objectOrder'>>,
      localIdOf: LocalIdOf,
    ): TickRecord {
      if (scenario.restartLocalBefore?.includes(index))
        simulation = create(JSON.parse(JSON.stringify(simulation.snapshot())) as WorldState);
      // This harness owns the live simulation; diagnostic controlled mode intentionally mutates
      // only its ordering inputs, bypassing the public read-only embedding view.
      const state = simulation.state as WorldState;
      if (controlledOrder) imposeObjectOrder(state, oracleTick.objectOrder ?? {}, localIdOf);
      objectOrder = {};
      const resolve = createResolver({
        roomObjects: Object.values(state.roomObjects),
        marketOrders: Object.values(state.marketOrders),
        userPowerCreeps: Object.values(state.userPowerCreeps),
      });
      const intents: Record<string, StoredUserIntents> = {};
      for (const userId of oracleTick.savedUsers) {
        const flat = resolve(required(scenario.ticks[index]).intents?.[userId] ?? {}) as RawIntents;
        intents[userId] = storeIntents(flat, (id) =>
          Object.prototype.hasOwnProperty.call(state.roomObjects, id)
            ? required(state.roomObjects[id]).room
            : undefined,
        );
      }
      if (controlledOrder) {
        // The local queue is activeRooms followed by rooms with intents, popped last first: arrange the
        // rooms the local side processes anyway so they pop in the oracle's order (none added or dropped).
        const localRooms = new Set([
          ...state.activeRooms,
          ...Object.values(intents).flatMap((stored) => Object.keys(stored.rooms)),
        ]);
        const oracleRooms = Object.keys(oracleTick.objectOrder ?? {}).filter((room) =>
          localRooms.has(room),
        );
        state.activeRooms = [
          ...[...localRooms].filter((room) => !oracleRooms.includes(room)),
          ...oracleRooms.reverse(),
        ];
      }
      const result = simulation.tick(intents);
      const roomErrors = result.errors
        .filter((error) => error.stage === 'room')
        .map((error) => ({
          room: required(error.room),
          message: required(error.message.split('\n')[0]),
        }));
      return {
        gameTime: result.gameTime,
        savedUsers: oracleTick.savedUsers,
        processedRooms: [...result.processedRooms, ...roomErrors.map((error) => error.room)],
        roomStats: result.roomStats,
        history: result.history,
        roomErrors,
        objectOrder,
        loopErrors: result.errors
          .filter((error) => error.stage === 'global')
          .map((error) => error.message),
        world: simulation.snapshot(),
      };
    },
  };
}
