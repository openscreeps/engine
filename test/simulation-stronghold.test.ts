import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as C from '../src/default-constants.ts';
import { createWorldState, Simulation } from '../src/simulation/index.ts';

const ROOM = 'W5N5';

function deployedStrongholdWorld() {
  return createWorldState({
    gameTime: 100,
    terrain: { [ROOM]: '0'.repeat(2500) },
    rooms: { [ROOM]: { _id: ROOM, status: 'normal' } },
    activeRooms: [ROOM],
    users: { '2': { _id: '2', username: 'Invader' } },
    roomObjects: {
      core: {
        _id: 'core',
        type: C.STRUCTURE_INVADER_CORE,
        room: ROOM,
        x: 25,
        y: 25,
        user: '2',
        level: 2,
        templateName: 'bunker2',
        strongholdId: 'sh1',
        strongholdBehavior: 'bunker2',
        hits: C.INVADER_CORE_HITS,
        hitsMax: C.INVADER_CORE_HITS,
        decayTime: 10_000,
        effects: [],
        store: {},
        actionLog: {},
      },
    },
  });
}

void describe('stronghold population', () => {
  void it('maintains the population the bulk persists as an index-keyed object', () => {
    const simulation = new Simulation(deployedStrongholdWorld());

    const first = simulation.tick({});
    assert.deepEqual(first.errors, []);

    const core = simulation.state.roomObjects.core;
    assert.ok(core);
    // Upstream persists the population as an index-keyed object: the driver bulk merges the new
    // array into the `{}` it substitutes for the absent value.
    assert.deepEqual(core.population, { 0: { body: 'weakDefender', behavior: 'simple-melee' } });
    assert.deepEqual(
      Object.values(simulation.state.roomObjects)
        .filter((o) => o.type === 'creep')
        .map((o) => o.name),
      ['defender0'],
    );

    const second = simulation.tick({});
    assert.deepEqual(second.errors, []);
  });
});
