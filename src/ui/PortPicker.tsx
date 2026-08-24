import { useState } from "react";
import type { Port, PortState } from "../domain/types";
import { PortList } from "./PortList";
import { PortMap } from "./PortMap";
import type { FreshnessThresholds } from "./freshness";
import { Button } from "./Ui";

/**
 * Choosing a port, either way round.
 *
 * SPEC 6.2 calls the list an *equal* alternative to the map rather than a
 * fallback. They are equal here in the sense that matters — each is one tap
 * away and either can complete the step — but they are no longer two tabs on
 * one cramped panel.
 *
 * The map opens full screen instead. Sharing the page column with the list
 * capped it at roughly 358x251 CSS pixels on a phone, which is what made its
 * markers untappable; the fix for that is area, and the only way to get area
 * on a phone is the whole screen. The list stays inline because it needs no
 * more room than a list ever does.
 */
export function PortPicker({
  ports,
  portStates,
  observations,
  shipRate,
  otherPortId,
  onPick,
  now,
  thresholds,
  stepLabel,
}: {
  ports: readonly Port[];
  portStates: ReadonlyMap<string, PortState>;
  observations: ReadonlyMap<string, string>;
  shipRate: number | null;
  otherPortId: string | null;
  onPick: (port: Port) => void;
  now: number;
  thresholds?: FreshnessThresholds;
  stepLabel: string;
}) {
  const [mapOpen, setMapOpen] = useState(false);

  return (
    <div>
      <div className="mb-4">
        <Button onClick={() => setMapOpen(true)} className="w-full sm:w-auto">
          <span aria-hidden="true">🗺</span> Choose on the map
        </Button>
        <p className="mt-2 text-xs text-slate-500">
          The map opens full screen. Search below if you already know the name —
          it is usually faster.
        </p>
      </div>

      <PortList
        ports={ports}
        portStates={portStates}
        observations={observations}
        shipRate={shipRate}
        otherPortId={otherPortId}
        onPick={onPick}
        now={now}
        thresholds={thresholds}
      />

      {mapOpen ? (
        <PortMap
          ports={ports}
          portStates={portStates}
          observations={observations}
          shipRate={shipRate}
          otherPortId={otherPortId}
          onPick={(port) => {
            setMapOpen(false);
            onPick(port);
          }}
          onClose={() => setMapOpen(false)}
          now={now}
          thresholds={thresholds}
          stepLabel={stepLabel}
        />
      ) : null}
    </div>
  );
}
