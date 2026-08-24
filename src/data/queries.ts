import { supabase } from '../lib/supabase';
import {
  toCurrentPrice,
  toGood,
  toPort,
  toPortState,
  toShip,
  toUpgrade,
} from './mappers';
import type { CurrentPrice, Good, Port, PortState, Ship, Upgrade } from '../domain/types';

/**
 * Everything the UI reads from the database.
 *
 * Two loads, deliberately:
 *
 *   loadReference()   ports, ships, goods, upgrades — global, fetched once
 *   loadServerData()  port state and prices — per server, refetched on switch
 *
 * Prices for the whole server are pulled in one go rather than per route. It
 * costs one query instead of one per port pair, and it is what makes the map's
 * freshness markers and the "nearest profitable port" suggestion instant
 * instead of a round trip each.
 */

export interface ServerRow {
  id: string;
  name: string;
}

export interface ReferenceData {
  ports: Port[];
  ships: Ship[];
  goods: Good[];
  upgrades: Upgrade[];
  servers: ServerRow[];
}

export interface ServerData {
  serverId: string;
  portStates: Map<string, PortState>;
  prices: CurrentPrice[];
}

/** PostgREST caps a response at 1,000 rows unless a range is asked for. */
const PAGE_SIZE = 1000;

function client() {
  if (!supabase) {
    throw new Error(
      'The app is not connected to its database. VITE_SUPABASE_URL and ' +
        'VITE_SUPABASE_ANON_KEY are missing from this deployment.',
    );
  }
  return supabase;
}

async function fetchAll(table: string, filter?: { column: string; value: string }) {
  const rows: Record<string, unknown>[] = [];
  // Paging matters here: 42 ports of 61 goods is 2,562 price rows, well past
  // the default cap. A silently truncated page would look like missing data
  // and quietly change which cargo the optimiser recommends.
  for (let from = 0; ; from += PAGE_SIZE) {
    let query = client().from(table).select('*').range(from, from + PAGE_SIZE - 1);
    if (filter) query = query.eq(filter.column, filter.value);
    const { data, error } = await query;
    if (error) throw new Error(`Could not read ${table}: ${error.message}`);
    const page = (data ?? []) as Record<string, unknown>[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

export async function loadReference(): Promise<ReferenceData> {
  const [ports, ships, goods, upgrades, servers] = await Promise.all([
    fetchAll('ports'),
    fetchAll('ships'),
    fetchAll('goods'),
    fetchAll('upgrades'),
    fetchAll('servers'),
  ]);

  return {
    ports: ports.map(toPort).sort((a, b) => (a.displayName ?? a.name).localeCompare(b.displayName ?? b.name)),
    ships: ships.map(toShip).sort((a, b) => a.rate - b.rate || a.name.localeCompare(b.name)),
    goods: goods.map(toGood).sort((a, b) => a.name.localeCompare(b.name)),
    upgrades: upgrades.map(toUpgrade).sort((a, b) => a.name.localeCompare(b.name)),
    servers: servers
      .map((row) => ({ id: String(row.id), name: String(row.name) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export async function loadServerData(serverId: string): Promise<ServerData> {
  const [states, prices] = await Promise.all([
    fetchAll('port_state_current', { column: 'server_id', value: serverId }),
    fetchAll('prices_current', { column: 'server_id', value: serverId }),
  ]);

  const portStates = new Map<string, PortState>();
  for (const row of states) {
    const state = toPortState(row);
    portStates.set(state.portId, state);
  }

  return { serverId, portStates, prices: prices.map(toCurrentPrice) };
}

/**
 * The most recent price observation at each port, for the map markers.
 *
 * Newest rather than oldest here, and on purpose: the marker answers "has
 * anyone been here lately", which is a question about the last visit. The
 * per-good rows in the results table use the older of their two observations,
 * because there the question is how much to trust one specific number.
 */
export function latestObservationByPort(prices: readonly CurrentPrice[]): Map<string, string> {
  const latest = new Map<string, string>();
  for (const price of prices) {
    const seen = latest.get(price.portId);
    if (seen === undefined || price.observedAt > seen) latest.set(price.portId, price.observedAt);
  }
  return latest;
}

/** True when a port has no recorded price at all — the "never recorded" band. */
export function portsWithPrices(prices: readonly CurrentPrice[]): Set<string> {
  return new Set(prices.map((price) => price.portId));
}
