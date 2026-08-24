import { FRESHNESS_CLASS, freshnessFor, type FreshnessThresholds } from './freshness';

/**
 * How old a price is (SPEC 6.3).
 *
 * Three signals every time — colour, icon, and words — because colour alone
 * fails for a colour-blind user, on a sunlit phone, and in a screen reader.
 */
export function FreshnessBadge({
  observedAt,
  now,
  thresholds,
  showAge = true,
}: {
  observedAt: string | null | undefined;
  now: number;
  thresholds?: FreshnessThresholds;
  showAge?: boolean;
}) {
  const band = freshnessFor(observedAt, now, thresholds);
  const classes = FRESHNESS_CLASS[band.level];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${classes.chip}`}
      title={band.meaning}
    >
      <span aria-hidden="true">{band.icon}</span>
      <span>{band.label}</span>
      {showAge && band.ageText ? (
        <span className="font-normal opacity-80">· {band.ageText}</span>
      ) : null}
    </span>
  );
}

/** The compact form for a map marker: a dot, with the words for assistive tech. */
export function FreshnessDot({
  observedAt,
  now,
  thresholds,
}: {
  observedAt: string | null | undefined;
  now: number;
  thresholds?: FreshnessThresholds;
}) {
  const band = freshnessFor(observedAt, now, thresholds);
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className={`size-2.5 shrink-0 rounded-full ${FRESHNESS_CLASS[band.level].dot}`}
      />
      <span className={`text-xs ${FRESHNESS_CLASS[band.level].text}`}>
        <span aria-hidden="true">{band.icon} </span>
        {band.label}
      </span>
    </span>
  );
}
