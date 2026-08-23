/**
 * Core domain types.
 *
 * Nothing game-derived is hardcoded anywhere in this file — these are shapes,
 * not values. Every actual number arrives from the database at runtime
 * (CLAUDE.md hard rule 2).
 */

/**
 * An integer number of *tenths of a gold piece*.
 *
 * The game shows one decimal place (4.2, 18.9), so 4.2 gold is stored as 42.
 * All money arithmetic happens on these integers; the conversion to a decimal
 * string happens only at render time (CLAUDE.md hard rule 3).
 */
export type Tenths = number;

/**
 * An integer number of hundredths of a percent. 8% is 800.
 *
 * Tax is stored in the database as a decimal percentage because that is how the
 * game displays it, but it is converted to this integer form before it touches
 * any money calculation, so that no float ever multiplies a price.
 */
export type BasisPoints = number;

export interface Good {
  id: string;
  name: string;
  /** Cargo space consumed per unit. Same units as ship hold (confirmed 1:1). */
  weight: number;
  /** Tooltip "Value". Reference and sanity-checking only — never a live price. */
  baseValue: Tenths | null;
  /** Observed price band, used only to flag outlying submissions. */
  minPrice: Tenths | null;
  maxPrice: Tenths | null;
  /** true for the 20 trade goods, false for craft materials and special items. */
  isTradeGood: boolean;
  perishable: boolean;
  category: string | null;
}

export interface Ship {
  id: string;
  name: string;
  shipClass: string;
  hullType: string | null;
  /** 1..7, converted from the in-game Roman numeral. 7 is the smallest. */
  rate: number;
  durability: number | null;
  /** BASE speed. The in-game HUD shows base..maxCruise; cards show base only. */
  speed: number | null;
  maneuverability: number | null;
  armor: number | null;
  /** The only cargo constraint. There is no cargo-slot limit. */
  hold: number;
  crew: number | null;
  upgradeSlots: number | null;
  verified: boolean;
}

export interface Upgrade {
  id: string;
  name: string;
  category: string | null;
  holdFlat: number;
  holdPercent: number;
  speedFlat: number;
  speedPercent: number;
  /** Sails raise the *cruise* ceiling, not base speed. Informational in V1. */
  cruiseSpeedFlat: number;
  durabilityFlat: number;
  durabilityPercent: number;
  upgradeSlotsFlat: number;
  preventsSpoilage: boolean;
}

export interface Port {
  id: string;
  name: string;
  displayName: string | null;
  /** Map pixel coordinates. Meaningful only as relative distance. */
  x: number;
  y: number;
  category: string | null;
}

/**
 * Per-server mutable port state. Every field here changes over time through
 * guild capture and patches, so all of it is nullable and user-editable.
 */
export interface PortState {
  portId: string;
  serverId: string;
  /** null means UNKNOWN. Never substitute a default — observed values are 4..12. */
  taxPercent: number | null;
  /** null means UNKNOWN. Never directly observed in game. Treated as 0, flagged. */
  dockingFee: Tenths | null;
  /** e.g. 6 means only rate 6 and 7 ships may dock AND undock. */
  minShipRate: number | null;
  controllingFaction: string | null;
  portLevel: number | null;
  portType: 'city' | 'settlement' | null;
  hasMarket: boolean;
}

/** One row of the `prices_current` view: the price the calculator should use. */
export interface CurrentPrice {
  serverId: string;
  portId: string;
  goodId: string;
  buyPrice: Tenths | null;
  sellPrice: Tenths | null;
  /**
   * null is COMMON and does not mean zero. The Market screen shows no quantity
   * for the 20 trade goods, so most trade-good rows have null stock. Treating it
   * as zero silently empties every cargo plan (SPEC.md §5.5).
   */
  stock: number | null;
  observedAt: string;
  isDemo: boolean;
  source: string;
}
