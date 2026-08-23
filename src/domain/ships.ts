import type { Ship, Upgrade } from './types';

export interface EffectiveShipStats {
  /** Cargo capacity after upgrades. The only cargo constraint. */
  hold: number;
  /** BASE speed after upgrades. Actual speed varies with wind, sails and load. */
  speed: number | null;
  durability: number | null;
  /** Cruise-speed bonus from sails. Shown to the user, NOT used in profit maths. */
  cruiseSpeedBonus: number;
  upgradeSlots: number | null;
  /** True when the ship's own record is marked unverified. */
  unverifiedShip: boolean;
}

/**
 * Apply upgrade modifiers to a ship's base stats.
 *
 * Ordering is FLAT FIRST, THEN PERCENT:
 *
 *   effective = (base + sum of flat) * (1 + sum of percent / 100)
 *
 * This is not a guess. It reproduces observed in-game values: Le Cerf's hold
 * 8000 + 3000 = 11000 live, its durability 900 * 0.95 = 855 live, Russia's
 * 22000 + 3000 + 1500 = 26500 live, and Horizont's 850 + 80 = 930 live
 * (ships.json `_meta.validationEvidence`).
 *
 * A preset with zero upgrades is valid and must never be treated as incomplete.
 */
export function effectiveShipStats(ship: Ship, upgrades: readonly Upgrade[] = []): EffectiveShipStats {
  let holdFlat = 0;
  let holdPercent = 0;
  let speedFlat = 0;
  let speedPercent = 0;
  let durabilityFlat = 0;
  let durabilityPercent = 0;
  let cruiseSpeedBonus = 0;
  let slotsFlat = 0;

  for (const u of upgrades) {
    holdFlat += u.holdFlat;
    holdPercent += u.holdPercent;
    speedFlat += u.speedFlat;
    speedPercent += u.speedPercent;
    durabilityFlat += u.durabilityFlat;
    durabilityPercent += u.durabilityPercent;
    cruiseSpeedBonus += u.cruiseSpeedFlat;
    slotsFlat += u.upgradeSlotsFlat;
  }

  const applyModifiers = (base: number, flat: number, percent: number): number =>
    (base + flat) * (1 + percent / 100);

  return {
    hold: applyModifiers(ship.hold, holdFlat, holdPercent),
    speed: ship.speed === null ? null : applyModifiers(ship.speed, speedFlat, speedPercent),
    durability:
      ship.durability === null
        ? null
        : applyModifiers(ship.durability, durabilityFlat, durabilityPercent),
    cruiseSpeedBonus,
    upgradeSlots: ship.upgradeSlots === null ? null : ship.upgradeSlots + slotsFlat,
    unverifiedShip: !ship.verified,
  };
}

/**
 * Usable hold capacity as a whole number of weight units.
 *
 * Cargo comes in whole units, so a fractional capacity from a percentage
 * upgrade rounds down — claiming the extra fraction would overstate what fits.
 */
export function usableHold(stats: EffectiveShipStats): number {
  return Math.max(0, Math.floor(stats.hold));
}
