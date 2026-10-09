import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createWorldState, Simulation } from '../src/simulation/index.ts';

function intershardMarketWorld() {
  return createWorldState({
    gameTime: 10,
    users: {
      u1: { _id: 'u1', username: 'buyer', money: 1_000_000, resources: {} },
      u2: { _id: 'u2', username: 'seller', money: 0, resources: { pixel: 10 } },
    },
    marketOrders: {
      o1: {
        _id: 'o1',
        user: 'u2',
        type: 'sell',
        resourceType: 'pixel',
        price: 2000,
        amount: 10,
        remainingAmount: 10,
        totalAmount: 10,
        active: true,
        createdTimestamp: 0,
      },
    },
  });
}

void describe('intershard market deals', () => {
  void it('moves account resources and credits between users as nested balances', () => {
    const simulation = new Simulation(intershardMarketWorld(), { now: () => 1000 });
    const result = simulation.tick({
      u1: { rooms: {}, global: { deal: [{ orderId: 'o1', amount: 3, targetRoomName: '' }] } },
    });
    assert.deepEqual(result.errors, []);

    const state = simulation.snapshot();
    const buyer = state.users.u1;
    const seller = state.users.u2;
    assert.ok(buyer && seller);
    assert.equal(buyer.money, 1_000_000 - 6000);
    assert.equal(seller.money, 6000);
    assert.deepEqual(buyer.resources, { pixel: 3 });
    assert.deepEqual(seller.resources, { pixel: 7 });
    for (const user of [buyer, seller]) {
      assert.ok(
        !Object.keys(user).some((key) => key.startsWith('resources.')),
        'no dotted top-level keys',
      );
    }

    const order = state.marketOrders.o1;
    assert.ok(order);
    assert.equal(order.amount, 7);
    assert.equal(order.remainingAmount, 7);
  });

  void it('accumulates balances across consecutive deals', () => {
    const simulation = new Simulation(intershardMarketWorld(), { now: () => 1000 });
    for (let i = 0; i < 2; i++) {
      simulation.tick({
        u1: { rooms: {}, global: { deal: [{ orderId: 'o1', amount: 2, targetRoomName: '' }] } },
      });
    }
    const state = simulation.snapshot();
    const buyer = state.users.u1;
    const seller = state.users.u2;
    assert.ok(buyer && seller);
    assert.deepEqual(buyer.resources, { pixel: 4 });
    assert.deepEqual(seller.resources, { pixel: 6 });
    assert.equal(seller.money, 8000);
  });
});
