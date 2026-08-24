import type { ServerRow } from '../data/queries';
import { Button, Panel } from './Ui';

/**
 * Which server's economy to read.
 *
 * This is not cosmetic. Every price and port-state row is scoped by server, and
 * NA prices tell a EU player nothing at all — mixing them produces garbage. So
 * the app never guesses: it asks once, remembers the answer, and shows it in
 * the header where it can be changed.
 */
export function ServerPrompt({
  servers,
  onChoose,
}: {
  servers: readonly ServerRow[];
  onChoose: (serverId: string) => void;
}) {
  return (
    <Panel>
      <h2 className="text-xl font-semibold text-slate-100">Which server do you play on?</h2>
      <p className="mt-2 text-sm text-slate-400">
        Each server has its own economy, so prices from one are meaningless on another.
        You can change this later from the header.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        {servers.map((server) => (
          <Button key={server.id} variant="primary" onClick={() => onChoose(server.id)}>
            {server.name}
          </Button>
        ))}
      </div>
      {servers.length === 0 ? (
        <p className="mt-4 text-sm text-amber-200/90">
          No servers are listed in the database yet, which means the seed data has not
          finished loading. Try again in a moment.
        </p>
      ) : null}
    </Panel>
  );
}

/** The header control: current server, and a way to change it. */
export function ServerBadge({
  servers,
  serverId,
  onChange,
}: {
  servers: readonly ServerRow[];
  serverId: string;
  onChange: (serverId: string) => void;
}) {
  const current = servers.find((server) => server.id === serverId);
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-slate-400">Server</span>
      <select
        value={serverId}
        onChange={(event) => onChange(event.target.value)}
        className="min-h-11 rounded-xl border border-slate-700 bg-slate-800/70 px-3 text-slate-100
          focus:border-amber-400 focus:outline-none"
        aria-label={`Server: ${current?.name ?? serverId}. Change server.`}
      >
        {servers.map((server) => (
          <option key={server.id} value={server.id}>
            {server.name}
          </option>
        ))}
      </select>
    </label>
  );
}
