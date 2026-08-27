import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * The screenshot endpoint as a whole: who may call it, what it refuses, and
 * what it costs when it refuses.
 *
 * Every request here spends real money at Anthropic, which makes this endpoint
 * different from every other one in the project. So the checks that matter are
 * the ones that happen BEFORE the model is called -- an unauthenticated caller,
 * a caller over their limit, or a broken usage counter must all cost nothing.
 * Several tests assert not just the status code but that the model was never
 * reached.
 */

const stream = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { stream };
  },
}));

const { default: handler } = await import('../../api/ocr');

/** A real PNG signature, so the magic-byte check passes. */
const PNG = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');

const GOODS = [{ id: 'copper', name: 'Copper', min_price: 180, max_price: 260 }];

function reply(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
}

interface Captured {
  status: number;
  body: Record<string, unknown>;
}

function res(): { res: unknown; sent: Captured } {
  const sent: Captured = { status: 0, body: {} };
  const object = {
    status(code: number) {
      sent.status = code;
      return object;
    },
    json(body: unknown) {
      sent.body = body as Record<string, unknown>;
    },
    setHeader() {},
  };
  return { res: object, sent };
}

function post(body: unknown, token = 'good-token') {
  return {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body,
  };
}

/** Answers for the three Supabase calls the endpoint makes, in any order. */
function supabaseRoutes(over: { allowed?: boolean; user?: boolean; chargeOk?: boolean } = {}) {
  return vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('/auth/v1/user')) {
      return over.user === false ? reply({}, false, 401) : reply({ id: 'user-1' });
    }
    if (url.includes('rpc/ocr_charge')) {
      if (over.chargeOk === false) return reply({}, false, 500);
      return reply({ allowed: over.allowed !== false, hour: 3, day: 9 });
    }
    if (url.includes('/rest/v1/goods')) return reply(GOODS);
    throw new Error(`unexpected fetch: ${url}`);
  });
}

const ENV = { ...process.env };

beforeEach(() => {
  stream.mockReset();
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-do-not-use';
  process.env.VITE_SUPABASE_URL = 'https://example.supabase.co';
  process.env.VITE_SUPABASE_ANON_KEY = 'anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
});

afterEach(() => {
  process.env = { ...ENV };
  vi.unstubAllGlobals();
});

function modelAnswers(payload: unknown) {
  stream.mockReturnValue({
    finalMessage: async () => ({
      content: [{ type: 'text', text: JSON.stringify(payload) }],
    }),
  });
}

describe('who gets to spend money here', () => {
  test('a request with no sign-in never reaches the model', async () => {
    vi.stubGlobal('fetch', supabaseRoutes());
    const { res: r, sent } = res();
    await handler({ ...post({ image: PNG, mediaType: 'image/png' }, '') } as never, r as never);
    expect(sent.status).toBe(401);
    expect(stream).not.toHaveBeenCalled();
  });

  test('a sign-in the database does not recognise never reaches the model', async () => {
    vi.stubGlobal('fetch', supabaseRoutes({ user: false }));
    const { res: r, sent } = res();
    await handler(post({ image: PNG, mediaType: 'image/png' }) as never, r as never);
    expect(sent.status).toBe(401);
    expect(stream).not.toHaveBeenCalled();
  });

  test('a caller over their limit is refused, and told manual entry still works', async () => {
    vi.stubGlobal('fetch', supabaseRoutes({ allowed: false }));
    const { res: r, sent } = res();
    await handler(post({ image: PNG, mediaType: 'image/png' }) as never, r as never);
    expect(sent.status).toBe(429);
    expect(String(sent.body.error)).toMatch(/manual entry/i);
    expect(stream).not.toHaveBeenCalled();
  });

  test('a broken usage counter fails closed', async () => {
    // The counter is the only thing between one bad actor and the whole
    // month's budget. If it cannot be consulted, nothing is read.
    vi.stubGlobal('fetch', supabaseRoutes({ chargeOk: false }));
    const { res: r, sent } = res();
    await handler(post({ image: PNG, mediaType: 'image/png' }) as never, r as never);
    expect(sent.status).toBe(500);
    expect(stream).not.toHaveBeenCalled();
  });

  test('the usage counter is consulted before the model, not after', async () => {
    const order: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes('/auth/v1/user')) return reply({ id: 'user-1' });
        if (url.includes('rpc/ocr_charge')) {
          order.push('charge');
          return reply({ allowed: true, hour: 1, day: 1 });
        }
        if (url.includes('/rest/v1/goods')) return reply(GOODS);
        throw new Error(url);
      }),
    );
    stream.mockImplementation(() => {
      order.push('model');
      return { finalMessage: async () => ({ content: [{ type: 'text', text: '{"rows":[]}' }] }) };
    });
    const { res: r } = res();
    await handler(post({ image: PNG, mediaType: 'image/png' }) as never, r as never);
    expect(order).toEqual(['charge', 'model']);
  });
});

describe('configuration and readiness', () => {
  test('a GET says whether this deployment can read screenshots', async () => {
    const { res: r, sent } = res();
    await handler({ method: 'GET', headers: {} } as never, r as never);
    expect(sent.body).toMatchObject({ ready: true, missing: [] });
  });

  test('readiness names what is missing but never its value', async () => {
    process.env.ANTHROPIC_API_KEY = '';
    const { res: r, sent } = res();
    await handler({ method: 'GET', headers: {} } as never, r as never);
    expect(sent.body).toMatchObject({ ready: false, missing: ['ANTHROPIC_API_KEY'] });
    expect(JSON.stringify(sent.body)).not.toContain('service-key');
  });

  test('with no API key the feature is off and says so, rather than failing oddly', async () => {
    process.env.ANTHROPIC_API_KEY = '';
    vi.stubGlobal('fetch', supabaseRoutes());
    const { res: r, sent } = res();
    await handler(post({ image: PNG, mediaType: 'image/png' }) as never, r as never);
    expect(sent.status).toBe(503);
    expect(String(sent.body.error)).toMatch(/Manual entry still works/);
  });

  test('anything other than GET or POST is refused', async () => {
    const { res: r, sent } = res();
    await handler({ method: 'DELETE', headers: {} } as never, r as never);
    expect(sent.status).toBe(405);
  });
});

describe('a successful read', () => {
  test('returns checked rows, and no secret is anywhere in the response', async () => {
    vi.stubGlobal('fetch', supabaseRoutes());
    modelAnswers({
      screen: 'market',
      port_name: 'Fiji Bay',
      port_kind: 'city',
      notes: null,
      rows: [{ good_id: 'copper', printed: 'Copper', buy: null, sell: '22.0', stock: '40' }],
    });
    const { res: r, sent } = res();
    await handler(post({ image: PNG, mediaType: 'image/png' }) as never, r as never);

    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ screen: 'market', portName: 'Fiji Bay' });
    const serialised = JSON.stringify(sent.body);
    expect(serialised).not.toContain('sk-ant-test-do-not-use');
    expect(serialised).not.toContain('service-key');
  });

  test('the image is sent as base64 with the type that was verified from its bytes', async () => {
    vi.stubGlobal('fetch', supabaseRoutes());
    modelAnswers({ rows: [] });
    const { res: r } = res();
    await handler(post({ image: PNG, mediaType: 'image/png' }) as never, r as never);

    const request = stream.mock.calls[0]![0] as {
      messages: { content: { type: string; source?: { media_type: string; data: string } }[] }[];
      system: { cache_control?: unknown }[];
    };
    const image = request.messages[0]!.content.find((part) => part.type === 'image');
    expect(image?.source?.media_type).toBe('image/png');
    expect(Buffer.from(image!.source!.data, 'base64').subarray(0, 8).toString('hex')).toBe(
      '89504e470d0a1a0a',
    );
    // The goods list and rules are identical on every call, so they are cached.
    expect(request.system[0]?.cache_control).toEqual({ type: 'ephemeral' });
  });

  test('an unreadable answer from the model is reported, never half-parsed', async () => {
    vi.stubGlobal('fetch', supabaseRoutes());
    stream.mockReturnValue({
      finalMessage: async () => ({ content: [{ type: 'text', text: 'sorry, I cannot' }] }),
    });
    const { res: r, sent } = res();
    await handler(post({ image: PNG, mediaType: 'image/png' }) as never, r as never);
    expect(sent.status).toBe(502);
    expect(String(sent.body.error)).toMatch(/Nothing was changed/);
  });

  test('the model being unreachable is a readable error, not a crash', async () => {
    vi.stubGlobal('fetch', supabaseRoutes());
    stream.mockImplementation(() => {
      throw new Error('connect ECONNREFUSED');
    });
    const { res: r, sent } = res();
    await handler(post({ image: PNG, mediaType: 'image/png' }) as never, r as never);
    expect(sent.status).toBe(502);
    expect(String(sent.body.error)).toMatch(/ECONNREFUSED/);
  });

  test('a bad image is refused before the usage counter is even charged', async () => {
    const fetchMock = supabaseRoutes();
    vi.stubGlobal('fetch', fetchMock);
    const { res: r, sent } = res();
    await handler(post({ image: 'not-an-image', mediaType: 'image/png' }) as never, r as never);
    expect(sent.status).toBe(400);
    const charged = fetchMock.mock.calls.some((call) => String(call[0]).includes('ocr_charge'));
    expect(charged).toBe(false);
  });

  test('a JSON string body is accepted, as some runtimes deliver it', async () => {
    vi.stubGlobal('fetch', supabaseRoutes());
    modelAnswers({ rows: [] });
    const { res: r, sent } = res();
    await handler(
      post(JSON.stringify({ image: PNG, mediaType: 'image/png' })) as never,
      r as never,
    );
    expect(sent.status).toBe(200);
  });
});
