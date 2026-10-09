import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { capacityForResource, calcTerminalEnergyCost } from '../src/utils/index.ts';

// Consumer-visible capacity rules from the ISC-licensed official engine.
void describe('resource capacity', () => {
  void it('does not substitute shared capacity for a specialized resource restriction', () => {
    const spawn = {
      type: 'spawn',
      store: { energy: 100 },
      storeCapacityResource: { energy: 300 },
    };
    assert.equal(capacityForResource(spawn, 'energy'), 300);
    assert.equal(capacityForResource(spawn, 'H'), 0);
  });

  void it('uses the lab mineral compartment until a specific reagent occupies it', () => {
    const emptyLab = {
      type: 'lab',
      store: { energy: 2000 },
      storeCapacity: 5000,
      storeCapacityResource: { energy: 2000 },
    };
    const occupiedLab = {
      type: 'lab',
      store: { energy: 2000, UO: 1000 },
      storeCapacityResource: { energy: 2000, UO: 3000 },
    };
    assert.equal(capacityForResource(emptyLab, 'UO'), 3000);
    assert.equal(capacityForResource(occupiedLab, 'UO'), 3000);
    assert.equal(capacityForResource(occupiedLab, 'H'), 0);
    assert.equal(capacityForResource(occupiedLab, 'energy'), 2000);
  });
});

void describe('terminal transfer energy', () => {
  void it('rounds fractional cost upward and charges no distance fee at zero distance', () => {
    assert.equal(calcTerminalEnergyCost(1, 1), 1);
    assert.equal(calcTerminalEnergyCost(1000, 30), 633);
    assert.equal(calcTerminalEnergyCost(1000, 0), 0);
  });
});
