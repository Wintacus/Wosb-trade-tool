import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { PortMap } from './ui/PortMap';
import { toPort } from './data/mappers';
import portsFile from '../data/ports.json';
import type { Port, PortState } from './domain/types';

/**
 * A dev-only harness for driving the real map under an automated browser.
 *
 * It exists because the map's worst bugs were all touch bugs, and touch is the
 * one thing the unit tests cannot reach: they render to a string with no
 * browser, no layout and no fingers. This page mounts the REAL PortMap with
 * the REAL 42 ports so a headless Chromium can pinch, drag and tap it.
 *
 * It is never part of the production site. Vite's build input is index.html
 * alone, so this page exists only under `vite dev`.
 *
 * What it CANNOT do is reproduce the reported bug: that is iOS Safari's
 * `gesturestart`, which no Chromium build implements. See PROGRESS.md.
 */

const ports: Port[] = (portsFile as { ports: Record<string, unknown>[] }).ports.map(toPort);
const portStates = new Map<string, PortState>();
const observations = new Map<string, string>(
  ports.map((port, index) => [
    port.id,
    // A spread of ages so every freshness band appears somewhere on the map.
    new Date(Date.now() - index * 40 * 60 * 1000).toISOString(),
  ]),
);

function Harness() {
  return (
    <PortMap
      ports={ports}
      portStates={portStates}
      observations={observations}
      shipRate={5}
      otherPortId={null}
      onPick={(port) => {
        (window as unknown as { picked?: string }).picked = port.id;
      }}
      onClose={() => {
        (window as unknown as { closed?: boolean }).closed = true;
      }}
      now={Date.now()}
      stepLabel="Harness: choosing where to buy"
    />
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
