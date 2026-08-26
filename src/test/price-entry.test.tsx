import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PortState } from '../domain/types';
import { PriceEntry } from '../ui/PriceEntry';
import { SERVER, makeGood, makePort, makePortState, makePrice } from './fixtures';

/**
 * Manual entry, rendered.
 *
 * renderToStaticMarkup runs the tree in Node without a DOM, so effects and
 * typing do not happen here — the parsing and validation that a keystroke
 * feeds are covered in submit.test.ts. What this catches is the class of bug
 * that is invisible to every other test and visible to nobody but the user, on
 * a phone, at the deployed URL: a screen that throws the moment it renders.
 */

const here = makePort('fiji', 0, 0, { displayName: 'Fiji Bay' });
const elsewhere = makePort('st_john', 100, 60, { displayName: "St John's" });

const goods = [
  makeGood('sugar', 10, { name: 'Sugar', isTradeGood: true }),
  makeGood('silk', 10, { name: 'Silk', isTradeGood: true }),
  makeGood('copper', 10, { name: 'Copper', isTradeGood: false }),
];

const states = new Map<string, PortState>([
  ['fiji', makePortState('fiji', { taxPercent: 8 })],
  ['st_john', makePortState('st_john', { taxPercent: 6 })],
]);

function render(initialPortId: string | null, prices = [makePrice('fiji', 'sugar', { sell: 400 })]) {
  return renderToStaticMarkup(
    <PriceEntry
      serverId={SERVER}
      ports={[here, elsewhere]}
      portStates={states}
      observations={new Map([['fiji', new Date().toISOString()]])}
      goods={goods}
      prices={prices}
      now={Date.now()}
      initialPortId={initialPortId}
      drafts={{}}
      onDraftsChange={() => {}}
      onClose={() => {}}
      onSaved={() => {}}
    />,
  );
}

describe('the entry screen renders', () => {
  it('asks which port when it does not know yet', () => {
    const html = render(null);
    expect(html).toContain('Which port are you at?');
    expect(html).toContain('Fiji Bay');
  });

  it('opens straight onto the goods when the port is known', () => {
    const html = render('fiji');
    expect(html).toContain('Prices at Fiji Bay');
    expect(html).toContain('Sugar');
    expect(html).toContain('Change port');
  });

  it('separates trade goods from craft resources', () => {
    const html = render('fiji');
    expect(html).toContain('Trade goods');
    expect(html).toContain('Craft resources');
  });

  it('shows what is on record without pre-filling the inputs', () => {
    // Pre-filling would turn Save into re-affirming numbers nobody looked at,
    // stamped with a fresh timestamp — a stale price laundered into a fresh
    // one, which is worse than having no price at all.
    const html = render('fiji');
    expect(html).toContain('sell 40.0');
    expect(html).not.toContain('value="40.0"');
  });

  it('renders unknown stock as words, never as zero', () => {
    const html = render('fiji');
    expect(html).toContain('stock not shown');
  });

  it('says plainly when a good has never been recorded here', () => {
    const html = render('fiji');
    expect(html).toContain('not recorded here');
  });

  it('marks placeholder data as placeholder', () => {
    const html = render('fiji', [makePrice('fiji', 'sugar', { sell: 400 }, { isDemo: true })]);
    expect(html).toContain('placeholder data');
  });

  it('offers no buy field for a trade good, but keeps one reachable', () => {
    // Confirmed in game 2026-08-26: the Market tab shows one number per trade
    // good and it is what the port pays you. An empty "Buy" box beside it
    // invites the same number in both, which manufactures profit from nothing.
    const html = render('fiji');
    const sugarRow = html.slice(html.indexOf('>Sugar<'), html.indexOf('>Silk<'));
    expect(sugarRow).not.toContain('placeholder="Buy"');
    expect(sugarRow).toContain('placeholder="Sell"');
    // The offer to add one lives once on the section, not once per row: at
    // ~40px a copy, twenty of them were a real part of why this screen took
    // 6.8 screens of scrolling.
    expect(html).toContain('Add a buy column');
    expect(html.match(/Add a buy column/g)).toHaveLength(1);
  });

  it('still offers buy and sell for a craft resource', () => {
    // Those genuinely have both, on the "Trade with port" tab.
    const html = renderToStaticMarkup(
      <PriceEntry
        serverId={SERVER}
        ports={[here, elsewhere]}
        portStates={states}
        observations={new Map()}
        goods={[makeGood('copper', 10, { name: 'Copper', isTradeGood: false })]}
        prices={[]}
        now={Date.now()}
        initialPortId="fiji"
        drafts={{}}
        onDraftsChange={() => {}}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );
    expect(html).toContain('placeholder="Buy"');
    expect(html).toContain('placeholder="Sell"');
    expect(html).not.toContain('Add a buy column');
  });

  it('cannot be saved until something is entered', () => {
    const html = render('fiji');
    expect(html).toContain('Nothing entered yet');
    expect(html).toMatch(/disabled[^>]*>\s*Save/);
  });
});
