import { describe, expect, test } from 'vitest';
import {
  toCurrentPrice,
  toGood,
  toPort,
  toPortState,
  toShip,
  toUpgrade,
} from '../data/mappers';

/**
 * Database rows to domain objects.
 *
 * This layer is where a null quietly becomes a number, and that is the single
 * most damaging thing that could happen in this project. CLAUDE.md's first
 * hard rule is that a null means UNKNOWN and must never be filled in with
 * something plausible: observed tax rates run from 4% to 12%, so defaulting to
 * the common 8% would produce confident, wrong profit figures with no warning
 * anywhere on screen.
 *
 * Mutation testing found this file untested. Making the mapper default tax to
 * 8% broke nothing, because every existing test happened to use a port with no
 * recorded state at all.
 */

describe('unknown stays unknown', () => {
  test('a null tax rate does not become 8, or anything else', () => {
    const state = toPortState({
      port_id: 'fiji',
      server_id: 'na',
      tax_percent: null,
      docking_fee: null,
      min_ship_rate: null,
      controlling_faction: null,
      port_level: null,
      port_type: null,
      has_market: true,
    });
    expect(state.taxPercent).toBeNull();
  });

  test('every unknown field on a port comes back null', () => {
    // An ABSENT key is undefined, not null. Mapping it with
    // `x === null ? null : String(x)` produced the literal text "undefined",
    // which would have been displayed as a real controlling faction.
    const state = toPortState({ port_id: 'x', server_id: 'na' });
    expect({
      tax: state.taxPercent,
      fee: state.dockingFee,
      rate: state.minShipRate,
      faction: state.controllingFaction,
      level: state.portLevel,
      type: state.portType,
    }).toEqual({
      tax: null,
      fee: null,
      rate: null,
      faction: null,
      level: null,
      type: null,
    });
  });

  test('a real zero is preserved rather than confused with unknown', () => {
    // A genuine 0% tax port is a different statement from an unrecorded one,
    // and the result screen says different things about each.
    const state = toPortState({
      port_id: 'x',
      server_id: 'na',
      tax_percent: 0,
      docking_fee: 0,
    });
    expect(state.taxPercent).toBe(0);
    expect(state.dockingFee).toBe(0);
  });

  test('null stock stays null, because it means "not shown", not "none"', () => {
    const price = toCurrentPrice({
      server_id: 'na',
      port_id: 'fiji',
      good_id: 'sugar',
      buy_price: 400,
      sell_price: 390,
      stock: null,
      observed_at: 'x',
      is_demo: false,
      source: 'manual',
    });
    expect(price.stock).toBeNull();
  });

  test('zero stock is preserved, because sold out is a real answer', () => {
    const price = toCurrentPrice({
      server_id: 'na',
      port_id: 'fiji',
      good_id: 'sugar',
      stock: 0,
      observed_at: 'x',
      source: 'manual',
    });
    expect(price.stock).toBe(0);
  });

  test('an absent price is null, not zero, so the good is excluded not free', () => {
    const price = toCurrentPrice({
      server_id: 'na',
      port_id: 'fiji',
      good_id: 'sugar',
      buy_price: null,
      sell_price: 390,
      observed_at: 'x',
      source: 'manual',
    });
    expect(price.buyPrice).toBeNull();
    expect(price.sellPrice).toBe(390);
  });

  test('an unrecorded ship stat stays null rather than becoming zero', () => {
    const ship = toShip({
      id: 'x',
      name: 'X',
      class: 'Fast',
      rate: 7,
      hold: 6000,
      upgrade_slots: null,
      speed: null,
    });
    expect(ship.upgradeSlots).toBeNull();
    expect(ship.speed).toBeNull();
  });
});

describe('Postgres numerics survive the trip', () => {
  test('a numeric arriving as a string is parsed, not left as text', () => {
    // Some clients return numeric columns as strings. Left alone, "8" would
    // compare and arithmetic in surprising ways.
    const state = toPortState({
      port_id: 'x',
      server_id: 'na',
      tax_percent: '8.5',
      docking_fee: '25',
    });
    expect(state.taxPercent).toBe(8.5);
    expect(state.dockingFee).toBe(25);
  });

  test('ship speed as a string becomes a number', () => {
    const ship = toShip({ id: 'x', name: 'X', class: 'F', rate: 7, hold: 100, speed: '8.8' });
    expect(ship.speed).toBe(8.8);
  });

  test('upgrade modifiers as strings become numbers', () => {
    const upgrade = toUpgrade({
      id: 'u',
      name: 'U',
      hold_flat: '3000',
      durability_percent: '-5',
    });
    expect(upgrade.holdFlat).toBe(3000);
    expect(upgrade.durabilityPercent).toBe(-5);
  });

  test('a missing modifier is zero, since no modifier means no effect', () => {
    // The one place a null legitimately becomes a number: an upgrade that does
    // not touch a stat leaves it alone, which is the same as adding zero.
    const upgrade = toUpgrade({ id: 'u', name: 'U' });
    expect(upgrade.holdFlat).toBe(0);
    expect(upgrade.speedPercent).toBe(0);
  });
});

describe('required fields are required', () => {
  test('a port without coordinates is refused rather than silently placed at 0,0', () => {
    expect(() => toPort({ id: 'x', name: 'X', x: null, y: 5 })).toThrow(/ports\.x/);
  });

  test('a ship without a hold is refused', () => {
    expect(() => toShip({ id: 'x', name: 'X', class: 'F', rate: 7, hold: null })).toThrow(
      /ships\.hold/,
    );
  });

  test('a good without a weight is refused', () => {
    expect(() => toGood({ id: 'x', name: 'X', weight: null })).toThrow(/goods\.weight/);
  });
});

describe('flags read correctly', () => {
  test('is_demo is only true when it really is true', () => {
    expect(toCurrentPrice({ server_id: 'a', port_id: 'b', good_id: 'c', is_demo: true, observed_at: 'x', source: 'demo' }).isDemo).toBe(true);
    expect(toCurrentPrice({ server_id: 'a', port_id: 'b', good_id: 'c', observed_at: 'x', source: 'manual' }).isDemo).toBe(false);
  });

  test('has_market defaults to usable when nobody has said otherwise', () => {
    // Unrecorded is not the same as "no market", and treating it as such would
    // hide ports from the user for no reason.
    expect(toPortState({ port_id: 'x', server_id: 'na' }).hasMarket).toBe(true);
    expect(toPortState({ port_id: 'x', server_id: 'na', has_market: false }).hasMarket).toBe(false);
  });

  test('a ship is treated as verified unless it says otherwise', () => {
    expect(toShip({ id: 'x', name: 'X', class: 'F', rate: 7, hold: 1 }).verified).toBe(true);
    expect(
      toShip({ id: 'x', name: 'X', class: 'F', rate: 7, hold: 1, verified: false }).verified,
    ).toBe(false);
  });
});
