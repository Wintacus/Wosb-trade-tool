import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import App from '../App';
import { planTrip } from '../domain/calculator';
import { suggestDestinations } from '../domain/suggest';
import type { Port, PortState } from '../domain/types';
import { Results } from '../ui/Results';
import { ShipPicker } from '../ui/ShipPicker';
import { SERVER, makeGood, makePort, makePortState, makePrice, makeShip } from './fixtures';

/**
 * Render smoke tests.
 *
 * TypeScript proves the props line up; it says nothing about whether a
 * component throws the moment it is actually rendered. A crash on the results
 * screen is invisible to every other test in this suite and would be found by
 * the user, on a phone, at the deployed URL — which is the one place this
 * project can be checked and the most expensive place to find a blank screen.
 *
 * renderToStaticMarkup runs the component tree in Node without a DOM. Effects
 * and event handlers do not run, so this is not a substitute for using the
 * app; it catches the class of bug where rendering itself explodes.
 */

const origin = makePort('origin', 0, 0, { displayName: 'Port Origin' });
const destination = makePort('destination', 120, 40, { displayName: 'Port Destination' });
const goods = [makeGood('rum', 5), makeGood('silk', 10), makeGood('lead', 2), makeGood('unpriced', 1)];
const ship = makeShip('fluyt', 5, 400);

const prices = [
  makePrice('origin', 'rum', { buy: 100 }),
  makePrice('destination', 'rum', { sell: 300 }),
  makePrice('origin', 'silk', { buy: 200 }),
  makePrice('destination', 'silk', { sell: 400 }),
  makePrice('origin', 'lead', { buy: 90 }),
  makePrice('destination', 'lead', { sell: 50 }),
  // A return-leg price, so the secondary section has something to show.
  makePrice('destination', 'rum', { buy: 120, sell: 300 }),
];

const states = new Map<string, PortState>([
  ['origin', makePortState('origin', { taxPercent: 5 })],
  ['destination', makePortState('destination', { taxPercent: 10 })],
]);

function trip(overrides: Partial<Parameters<typeof planTrip>[0]> = {}) {
  return planTrip({
    serverId: SERVER,
    origin,
    destination,
    originState: states.get('origin')!,
    destinationState: states.get('destination')!,
    ship,
    goods,
    prices,
    ...overrides,
  });
}

function renderResults(props: Partial<Parameters<typeof Results>[0]> = {}) {
  return renderToStaticMarkup(
    <Results
      trip={trip()}
      goods={goods}
      prices={prices}
      originState={states.get('origin')!}
      destinationState={states.get('destination')!}
      originName="Port Origin"
      destinationName="Port Destination"
      suggestions={[]}
      now={Date.parse('2026-08-24T12:00:00.000Z')}
      onPickSuggestion={() => {}}
      onChangeRoute={() => {}}
      onAddData={() => {}}
      {...props}
    />,
  );
}

describe('the app shell renders', () => {
  it('renders without a database configured, instead of showing a blank screen', () => {
    // There are no VITE_ variables in the test environment, which is the same
    // situation as a deployment that is missing them. The app must say so.
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain('WOSB Trade Tool');
    expect(html).toContain('Not affiliated');
  });
});

describe('the results screen renders', () => {
  it('renders a successful plan with its profit and supporting table', () => {
    const html = renderResults();
    expect(html).toContain('Port Origin');
    expect(html).toContain('Port Destination');
    // Every good on the route appears, including the ones not chosen.
    for (const good of ['rum', 'silk', 'lead', 'unpriced']) {
      expect(html).toContain(good);
    }
  });

  it('never prints money as a float', () => {
    // Prices are integer tenths; "4.2" is a rendering, not a stored value. A
    // stray float would show up as a long decimal tail.
    const html = renderResults();
    expect(html).not.toMatch(/\d+\.\d{3,}/);
  });

  it('shows unknown stock as "not shown" rather than as zero', () => {
    // Null stock is the normal case for trade goods and means the Market
    // displayed no quantity. Rendering it as 0 would empty every cargo plan.
    expect(renderResults()).toContain('not shown');
  });

  it('says out loud when the tax at the destination is unknown', () => {
    const unknownTax = new Map(states);
    unknownTax.set('destination', makePortState('destination', { taxPercent: null }));
    const html = renderResults({
      trip: trip({ destinationState: unknownTax.get('destination')! }),
      destinationState: unknownTax.get('destination')!,
    });
    expect(html.toLowerCase()).toContain('tax');
  });

  it('renders a route the ship cannot sail as an explanation, not a crash', () => {
    const blocked = makePortState('destination', { minShipRate: 7 });
    const html = renderResults({
      trip: trip({ destinationState: blocked }),
      destinationState: blocked,
    });
    // The calculator's own message carries the real numbers.
    expect(html).toContain('rate 7');
  });

  it('renders the same-port failure rather than an empty result', () => {
    const html = renderResults({
      trip: trip({ destination: origin, destinationState: states.get('origin')! }),
    });
    expect(html).toContain('same port');
  });

  it('offers somewhere else to go when nothing on the route turns a profit', () => {
    const elsewhere: Port = makePort('elsewhere', 40, 0, { displayName: 'Port Elsewhere' });
    const lossMaking = [
      makePrice('origin', 'rum', { buy: 100 }),
      makePrice('destination', 'rum', { sell: 40 }),
      makePrice('elsewhere', 'rum', { sell: 500 }),
    ];
    const portStates = new Map(states);
    portStates.set('elsewhere', makePortState('elsewhere'));

    const suggestions = suggestDestinations({
      serverId: SERVER,
      origin,
      originState: portStates.get('origin')!,
      ship,
      ports: [origin, destination, elsewhere],
      portStates,
      goods,
      prices: lossMaking,
      exclude: ['destination'],
    });
    expect(suggestions.length).toBeGreaterThan(0);

    const html = renderResults({
      trip: trip({ prices: lossMaking }),
      prices: lossMaking,
      suggestions,
    });
    expect(html).toContain('Port Elsewhere');
  });
});

describe('the ship picker renders', () => {
  it('renders base ships with no presets saved', () => {
    const html = renderToStaticMarkup(
      <ShipPicker
        ships={[ship, makeShip('brig', 6, 200)]}
        upgrades={[]}
        presets={[]}
        onPresetsChange={() => {}}
        selectedShipId={null}
        selectedPresetId={null}
        onSelect={() => {}}
      />,
    );
    expect(html).toContain('fluyt');
    expect(html).toContain('brig');
  });

  it('renders a preset whose ship has left the database without crashing', () => {
    // Presets live in the browser and outlive any single database row, so a
    // preset pointing at a deleted ship is a normal state, not a bug.
    const html = renderToStaticMarkup(
      <ShipPicker
        ships={[ship]}
        upgrades={[]}
        presets={[
          {
            id: 'p1',
            name: 'Old faithful',
            shipId: 'a-ship-that-no-longer-exists',
            upgradeIds: [],
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ]}
        onPresetsChange={() => {}}
        selectedShipId={null}
        selectedPresetId={null}
        onSelect={() => {}}
      />,
    );
    expect(html).toContain('Old faithful');
  });
});
