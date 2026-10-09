import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as C from '../src/constants.ts';
import { createWorldState, Simulation, type RoomObject } from '../src/simulation/index.ts';

const ROOM = 'W1N1';

function poweredRoomWorld(extra: Record<string, RoomObject>) {
  return createWorldState({
    gameTime: 100,
    terrain: { [ROOM]: '0'.repeat(2500) },
    rooms: { [ROOM]: { _id: ROOM, status: 'normal' } },
    activeRooms: [ROOM],
    users: { u1: { _id: 'u1', username: 'operator', rooms: [ROOM] } },
    roomObjects: {
      ctrl: {
        _id: 'ctrl',
        type: 'controller',
        room: ROOM,
        x: 40,
        y: 40,
        user: 'u1',
        level: 8,
        progress: 0,
        downgradeTime: 100_000,
        safeModeAvailable: 0,
        isPowerEnabled: true,
      },
      pc: {
        _id: 'pc',
        type: 'powerCreep',
        room: ROOM,
        x: 20,
        y: 20,
        user: 'u1',
        name: 'Operator',
        className: 'operator',
        level: 10,
        hits: 1000,
        hitsMax: 1000,
        ageTime: 5000,
        store: { ops: 300 },
        storeCapacity: 300,
        powers: {
          [C.PWR_OPERATE_FACTORY]: { level: 1 },
          [C.PWR_OPERATE_OBSERVER]: { level: 2 },
        },
        actionLog: {},
      },
      ...extra,
    },
  });
}

void describe('power creep powers', () => {
  void it('OPERATE_FACTORY sets the factory level and enables matching commodity production', () => {
    const simulation = new Simulation(
      poweredRoomWorld({
        factory: {
          _id: 'factory',
          type: 'factory',
          room: ROOM,
          x: 21,
          y: 20,
          user: 'u1',
          hits: 1000,
          hitsMax: 1000,
          cooldown: 0,
          store: { utrium_bar: 40, zynthium_bar: 40, energy: 40 },
          storeCapacity: C.FACTORY_CAPACITY,
        },
      }),
    );

    const first = simulation.tick({
      u1: {
        rooms: { [ROOM]: { pc: { usePower: { power: C.PWR_OPERATE_FACTORY, id: 'factory' } } } },
      },
    });
    assert.deepEqual(first.errors, []);

    const operated = simulation.state.roomObjects.factory;
    assert.ok(operated);
    assert.equal(operated.level, 1);
    // Upstream persists power effects as an index-keyed object: the driver bulk merges the new
    // array into the `null` written just before (`{effects: null}` then `{effects}`).
    assert.deepEqual(operated.effects, {
      0: {
        effect: C.PWR_OPERATE_FACTORY,
        power: C.PWR_OPERATE_FACTORY,
        level: 1,
        endTime: 100 + C.POWER_INFO[C.PWR_OPERATE_FACTORY].duration,
      },
    });
    assert.equal(simulation.state.roomObjects.pc?.store?.ops, 200);

    const second = simulation.tick({
      u1: { rooms: { [ROOM]: { factory: { produce: { resourceType: 'composite', amount: 0 } } } } },
    });
    assert.deepEqual(second.errors, []);
    const store = simulation.state.roomObjects.factory?.store;
    assert.ok(store);
    assert.equal(store.composite, C.COMMODITIES.composite.amount);
    assert.equal(store.utrium_bar, 20);
  });

  void it('duration-only OPERATE_OBSERVER applies its effect without a room error', () => {
    const simulation = new Simulation(
      poweredRoomWorld({
        observer: {
          _id: 'observer',
          type: 'observer',
          room: ROOM,
          x: 22,
          y: 22,
          user: 'u1',
          hits: 500,
          hitsMax: 500,
        },
      }),
    );

    const result = simulation.tick({
      u1: {
        rooms: { [ROOM]: { pc: { usePower: { power: C.PWR_OPERATE_OBSERVER, id: 'observer' } } } },
      },
    });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.processedRooms, [ROOM]);

    const observer = simulation.state.roomObjects.observer;
    assert.ok(observer);
    assert.deepEqual(observer.effects, {
      0: {
        effect: C.PWR_OPERATE_OBSERVER,
        power: C.PWR_OPERATE_OBSERVER,
        level: 2,
        endTime: 100 + (C.POWER_INFO[C.PWR_OPERATE_OBSERVER].duration[1] as number),
      },
    });
    const powerCreep = simulation.state.roomObjects.pc;
    assert.ok(powerCreep);
    assert.equal(powerCreep.powers?.[C.PWR_OPERATE_OBSERVER]?.cooldownTime, 100 + 400);
    assert.equal(powerCreep.store?.ops, 290);
  });
});
