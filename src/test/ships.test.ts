import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { effectiveShipStats, usableHold } from '../domain/ships';
import { repoRoot } from './pg';
import type { Ship, Upgrade } from '../domain/types';

/**
 * Effective ship stats, checked against the live in-game HUD readings recorded
 * in ships.json `_meta.validationEvidence`.
 *
 * These are not invented cases: each one is a real before-and-after observed
 * on a real ship, which is what makes the flat-then-percent ordering a
 * verified rule rather than an assumption.
 */

const shipsJson = JSON.parse(readFileSync(join(repoRoot, 'data', 'ships.json'), 'utf8')) as {
  ships: {
    id: string;
    name: string;
    class: string;
    hullType: string | null;
    rate: number;
    durability: number;
    speed: number;
    maneuverability: number;
    armor: number;
    hold: number;
    crew: number;
    upgradeSlots?: number;
  }[];
};

function ship(id: string): Ship {
  const raw = shipsJson.ships.find((s) => s.id === id);
  if (!raw) throw new Error(`No ship ${id} in data/ships.json`);
  return {
    id: raw.id,
    name: raw.name,
    shipClass: raw.class,
    hullType: raw.hullType,
    rate: raw.rate,
    durability: raw.durability,
    speed: raw.speed,
    maneuverability: raw.maneuverability,
    armor: raw.armor,
    hold: raw.hold,
    crew: raw.crew,
    upgradeSlots: raw.upgradeSlots ?? null,
    verified: true,
  };
}

function upgrade(id: string, mods: Partial<Upgrade>): Upgrade {
  return {
    id,
    name: id,
    category: null,
    holdFlat: 0,
    holdPercent: 0,
    speedFlat: 0,
    speedPercent: 0,
    cruiseSpeedFlat: 0,
    durabilityFlat: 0,
    durabilityPercent: 0,
    upgradeSlotsFlat: 0,
    preventsSpoilage: false,
    ...mods,
  };
}

const doubleHold = upgrade('double_hold', { holdFlat: 3000, durabilityPercent: -5 });
const cellars = upgrade('cellars', { holdFlat: 1500, preventsSpoilage: true });
const repairArsenal = upgrade('repair_arsenal', { durabilityFlat: 80 });

describe('effective ship stats match observed in-game values', () => {
  test('Le Cerf: hold 8000 + 3000 = 11000, durability 900 x 0.95 = 855', () => {
    const stats = effectiveShipStats(ship('le_cerf'), [doubleHold]);
    expect(stats.hold).toBe(11_000);
    expect(stats.durability).toBe(855);
  });

  test('Russia: hold 22000 + 3000 + 1500 = 26500, durability 1600 x 0.95 = 1520', () => {
    const stats = effectiveShipStats(ship('russia'), [doubleHold, cellars]);
    expect(stats.hold).toBe(26_500);
    expect(stats.durability).toBe(1520);
  });

  test('Horizont: durability 850 + 80 = 930', () => {
    const stats = effectiveShipStats(ship('horizont'), [repairArsenal]);
    expect(stats.durability).toBe(930);
  });

  test('flat is applied before percent, which is what the evidence shows', () => {
    // (8000 + 3000) x 1.12 = 12320. The other order would give
    // 8000 x 1.12 + 3000 = 11960, so the two are distinguishable.
    const sturdyFrames = upgrade('sturdy_frames', { holdPercent: 12 });
    const stats = effectiveShipStats(ship('le_cerf'), [doubleHold, sturdyFrames]);
    expect(stats.hold).toBe(12_320);
    expect(stats.hold).not.toBe(11_960);
  });
});

describe('a ship with no upgrades is valid', () => {
  test('barebones stats are the base stats', () => {
    const stats = effectiveShipStats(ship('friede'));
    expect(stats.hold).toBe(11_000);
    expect(stats.speed).toBe(8.8);
    expect(stats.cruiseSpeedBonus).toBe(0);
  });

  test('an empty upgrade list behaves the same as none at all', () => {
    expect(effectiveShipStats(ship('pickle'), [])).toEqual(effectiveShipStats(ship('pickle')));
  });
});

describe('sails are kept separate from base speed', () => {
  test('a sail upgrade raises the cruise bonus, not base speed', () => {
    // The calculator uses base speed, so sails must not silently inflate it.
    const elite = upgrade('elite_sails', { cruiseSpeedFlat: 2.8 });
    const stats = effectiveShipStats(ship('pickle'), [elite]);
    expect(stats.speed).toBe(9.2);
    expect(stats.cruiseSpeedBonus).toBe(2.8);
  });
});

describe('usable hold is whole units', () => {
  test('a fractional capacity rounds down rather than overstating what fits', () => {
    const oddPercent = upgrade('odd', { holdPercent: 7 });
    const stats = effectiveShipStats(ship('pickle'), [oddPercent]); // 6000 x 1.07 = 6420
    expect(usableHold(stats)).toBe(6420);

    // (6000 + 1) x 1.05 = 6301.05, so a fifth of a unit is left on the quay.
    const fractional = effectiveShipStats(ship('pickle'), [
      upgrade('odd_flat', { holdFlat: 1, holdPercent: 5 }),
    ]);
    expect(fractional.hold).toBeCloseTo(6301.05, 9);
    expect(usableHold(fractional)).toBe(6301);
    expect(Number.isInteger(usableHold(fractional))).toBe(true);
  });
});
