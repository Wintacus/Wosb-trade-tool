import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import handler, { candidateConnections, isAuthFailure, projectRef } from '../../api/migrate';
import { setupPage, resultPage } from '../../api/_page';

/**
 * The setup endpoint.
 *
 * The point of this endpoint is that the user does nothing but type one
 * password. That only holds if the project reference really is derivable from
 * the environment already present, so that is what these check.
 *
 * The database work itself is covered by embedded-sql.test.ts, which runs the
 * exact same SQL against a real Postgres.
 */

interface Captured {
  code: number;
  body: string;
  json: unknown;
  headers: Record<string, string>;
}

function mockResponse(): { res: never; captured: Captured } {
  const captured: Captured = { code: 0, body: '', json: null, headers: {} };
  const res = {
    status(code: number) {
      captured.code = code;
      return res;
    },
    send(body: string) {
      captured.body = body;
    },
    json(body: unknown) {
      captured.json = body;
    },
    setHeader(name: string, value: string) {
      captured.headers[name.toLowerCase()] = value;
    },
  };
  return { res: res as never, captured };
}

const ORIGINAL = process.env.VITE_SUPABASE_URL;

beforeEach(() => {
  process.env.VITE_SUPABASE_URL = 'https://abcdefghijklmnop.supabase.co';
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.VITE_SUPABASE_URL;
  else process.env.VITE_SUPABASE_URL = ORIGINAL;
});

describe('the project identifies itself, so the user does not have to', () => {
  test('the reference is read straight out of VITE_SUPABASE_URL', () => {
    expect(projectRef()).toBe('abcdefghijklmnop');
  });

  test('a trailing slash or stray whitespace does not break it', () => {
    process.env.VITE_SUPABASE_URL = '  https://abcdefghijklmnop.supabase.co/  ';
    expect(projectRef()).toBe('abcdefghijklmnop');
  });

  test('it falls back to SUPABASE_URL if that is what is set', () => {
    delete process.env.VITE_SUPABASE_URL;
    process.env.SUPABASE_URL = 'https://zyxwvutsrq.supabase.co';
    expect(projectRef()).toBe('zyxwvutsrq');
    delete process.env.SUPABASE_URL;
  });

  test('it returns null rather than guessing when nothing is set', () => {
    delete process.env.VITE_SUPABASE_URL;
    expect(projectRef()).toBeNull();
  });
});

describe('connection candidates', () => {
  const candidates = () => candidateConnections('abcdefghijklmnop', 'pa55 w/rd:@#');

  test('the direct host is tried first', () => {
    expect(candidates()[0]!.label).toBe('direct');
    expect(candidates()[0]!.url).toContain('@db.abcdefghijklmnop.supabase.co:5432');
  });

  test('pooler regions follow, since direct is IPv6-only on most projects', () => {
    const labels = candidates().map((c) => c.label);
    expect(labels.length).toBeGreaterThan(10);
    expect(labels).toContain('pooler us-east-1');
    expect(labels).toContain('pooler eu-central-1');
  });

  test('pooler URLs use the tenant-qualified username Supabase requires', () => {
    const pooler = candidates().find((c) => c.label === 'pooler us-east-1')!;
    expect(pooler.url).toContain('postgres.abcdefghijklmnop:');
    expect(pooler.url).toContain('@aws-0-us-east-1.pooler.supabase.com:5432');
  });

  test('a password containing URL punctuation is escaped, not mangled', () => {
    // A password with @ or : in it would otherwise corrupt the connection URL
    // and produce a baffling error.
    for (const candidate of candidates()) {
      expect(candidate.url).toContain(encodeURIComponent('pa55 w/rd:@#'));
      expect(candidate.url).not.toContain('pa55 w/rd:@#');
    }
    expect(() => new URL(candidates()[0]!.url)).not.toThrow();
  });
});

describe('a rejected password stops the search instead of hammering every host', () => {
  test.each([
    'password authentication failed for user "postgres"',
    'Tenant or user not found',
    'role "postgres" does not exist',
  ])('%s is recognised as an auth failure', (message) => {
    expect(isAuthFailure(message)).toBe(true);
  });

  test.each(['connect ETIMEDOUT', 'getaddrinfo ENOTFOUND', 'connect ECONNREFUSED'])(
    '%s is not, because another host may still work',
    (message) => {
      expect(isAuthFailure(message)).toBe(false);
    },
  );
});

describe('GET serves the form', () => {
  test('responds with HTML containing a password field', async () => {
    const { res, captured } = mockResponse();
    await handler({ method: 'GET', headers: {} }, res);

    expect(captured.code).toBe(200);
    expect(captured.headers['content-type']).toContain('text/html');
    expect(captured.body).toContain('type="password"');
    expect(captured.body).toContain('name="password"');
  });

  test('asks for nothing except the password', async () => {
    const { res, captured } = mockResponse();
    await handler({ method: 'GET', headers: {} }, res);

    // Exactly one required input. Anything else would be another chore.
    const required = captured.body.match(/<input(?![^>]*type="(checkbox|hidden)")[^>]*>/g) ?? [];
    const visible = required.filter((i) => !i.includes('connectionString'));
    expect(visible).toHaveLength(1);
  });

  test('shows the detected project so it is obvious nothing else is needed', async () => {
    const { res, captured } = mockResponse();
    await handler({ method: 'GET', headers: {} }, res);
    expect(captured.body).toContain('abcdefghijklmnop');
  });

  test('never sends the typed password onward in a referrer', async () => {
    const { res, captured } = mockResponse();
    await handler({ method: 'GET', headers: {} }, res);
    expect(captured.headers['referrer-policy']).toBe('no-referrer');
    expect(captured.headers['cache-control']).toBe('no-store');
  });

  test('links straight to the page where the password is reset', async () => {
    const { res, captured } = mockResponse();
    await handler({ method: 'GET', headers: {} }, res);
    expect(captured.body).toContain(
      'https://supabase.com/dashboard/project/_/settings/database',
    );
  });
});

describe('POST validates before touching anything', () => {
  test('an empty password is refused without attempting a connection', async () => {
    const { res, captured } = mockResponse();
    await handler({ method: 'POST', headers: {}, body: { password: '   ' } }, res);
    expect(captured.code).toBe(400);
    expect((captured.json as { ok: boolean }).ok).toBe(false);
  });

  test('a missing project reference is explained, not left as a crash', async () => {
    delete process.env.VITE_SUPABASE_URL;
    const { res, captured } = mockResponse();
    await handler({ method: 'POST', headers: {}, body: { password: 'hunter2' } }, res);
    expect(captured.code).toBe(500);
    expect(String((captured.json as { error: string }).error)).toMatch(/VITE_SUPABASE_URL/);
  });
});

describe('the pages render safely', () => {
  test('the result page reports each step and count', () => {
    const html = resultPage({
      ok: true,
      steps: [{ step: 'Connect', ok: true, detail: 'Connected via direct.' }],
      counts: [{ label: 'Ports', found: 42, expected: 42, ok: true }],
      prices: 115,
      portState: 4,
    });
    expect(html).toContain('Connect');
    expect(html).toContain('42 / 42');
    expect(html).toContain('115 price rows');
  });

  test('a failure says so plainly and offers a way back', () => {
    const html = resultPage({
      ok: false,
      steps: [{ step: 'Failed', ok: false, detail: 'relation does not exist' }],
      counts: [],
      prices: 0,
      portState: 0,
    });
    expect(html).toContain('Something went wrong');
    expect(html).toContain('/api/migrate');
  });

  test('error text is escaped, so a database message cannot inject markup', () => {
    const html = resultPage({
      ok: false,
      steps: [{ step: 'Failed', ok: false, detail: '<script>alert(1)</script>' }],
      counts: [],
      prices: 0,
      portState: 0,
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('the form still renders when the project could not be identified', () => {
    const html = setupPage(null);
    expect(html).toContain('VITE_SUPABASE_URL is not set');
    expect(html).toContain('connectionString');
  });
});
