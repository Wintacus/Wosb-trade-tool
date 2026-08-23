import { describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './pg';

/**
 * Guards on the seed data itself.
 *
 * SPEC.md 3.3 gives exact row counts and says to assert them. The SQL asserts
 * them at import time; these assert them at the source, so a bad edit to
 * data/*.json is caught before anyone pastes anything into Supabase.
 */

const readJson = (name: string) =>
  JSON.parse(readFileSync(join(repoRoot, 'data', name), 'utf8'));

const ports = readJson('ports.json');
const ships = readJson('ships.json');
const goods = readJson('goods.json');
const resources = readJson('resources.json');

describe('seed counts match SPEC.md 3.3', () => {
  test('42 ports', () => {
    expect(ports.ports).toHaveLength(42);
  });

  test('38 ships', () => {
    expect(ships.ships).toHaveLength(38);
  });

  test('20 trade goods', () => {
    expect(goods.goods).toHaveLength(20);
  });

  test('41 craft materials and special items', () => {
    expect(resources.craftMaterials.length + resources.specialItems.length).toBe(41);
  });

  test('61 goods in total, with no id collisions between the two sources', () => {
    const ids = [
      ...goods.goods.map((g: { id: string }) => g.id),
      ...resources.craftMaterials.map((m: { id: string }) => m.id),
      ...resources.specialItems.map((s: { id: string }) => s.id),
    ];
    expect(ids).toHaveLength(61);
    expect(new Set(ids).size).toBe(61);
  });
});

describe('seed data is structurally sound', () => {
  test('every port id is unique and every coordinate is a whole number', () => {
    const ids = ports.ports.map((p: { id: string }) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const port of ports.ports) {
      expect(Number.isInteger(port.x)).toBe(true);
      expect(Number.isInteger(port.y)).toBe(true);
    }
  });

  test('every ship has a rate of 1 to 7 and a positive hold', () => {
    for (const ship of ships.ships) {
      expect(ship.rate).toBeGreaterThanOrEqual(1);
      expect(ship.rate).toBeLessThanOrEqual(7);
      expect(ship.hold).toBeGreaterThan(0);
    }
  });

  test('every good has a positive whole-number weight', () => {
    const all = [...goods.goods, ...resources.craftMaterials, ...resources.specialItems];
    for (const good of all) {
      expect(Number.isInteger(good.weight)).toBe(true);
      expect(good.weight).toBeGreaterThan(0);
    }
  });

  test('no port ships with a tax rate or docking fee baked in', () => {
    // These change constantly and belong in port_state_submissions, recorded
    // by players as they see them.
    // A hardcoded tax rate is a bug waiting to happen.
    for (const port of ports.ports) {
      expect(port).not.toHaveProperty('taxPercent');
      expect(port).not.toHaveProperty('dockingFee');
      expect(port).not.toHaveProperty('minShipRate');
    }
  });

  test('every observed price falls inside its recorded sanity band', () => {
    // This is what makes the bands trustworthy as an outlier check.
    const bands = new Map(
      goods.goods.map((g: { id: string; minPrice: number; maxPrice: number }) => [
        g.id,
        [g.minPrice, g.maxPrice] as const,
      ]),
    );
    for (const set of [
      goods._validationEvidence.fijiBay_City,
      goods._validationEvidence.unnamedSettlement,
    ]) {
      for (const [goodId, price] of Object.entries(set as Record<string, number>)) {
        const band = bands.get(goodId) as readonly [number, number] | undefined;
        expect(band, `no price band for ${goodId}`).toBeDefined();
        expect(price).toBeGreaterThanOrEqual(band![0]);
        expect(price).toBeLessThanOrEqual(band![1]);
      }
    }
  });
});

describe('the committed SQL matches its generator', () => {
  test('seed.sql and demo_prices.sql are up to date', () => {
    // The SQL files are generated from data/*.json. If someone edits the JSON
    // and forgets to regenerate, the user would paste stale data into
    // Supabase and never know.
    const paths = ['seed.sql', 'demo_prices.sql'].map((f) => join(repoRoot, 'supabase', f));
    const before = paths.map((p) => readFileSync(p, 'utf8'));

    execFileSync('node', ['scripts/gen-sql.mjs'], { cwd: repoRoot });
    execFileSync('node', ['scripts/gen-demo-sql.mjs'], { cwd: repoRoot });

    const after = paths.map((p) => readFileSync(p, 'utf8'));

    // Leave the working tree exactly as it was found, whatever the outcome.
    paths.forEach((p, i) => writeFileSync(p, before[i]!, 'utf8'));

    for (const [i, path] of paths.entries()) {
      expect(
        after[i],
        `${path} is stale. Run: npm run gen:sql`,
      ).toBe(before[i]);
    }
  });
});
