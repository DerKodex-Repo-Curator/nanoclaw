import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GatewayApprovalRequest, GatewaySessionInput } from './gateway-provider-registry.js';

const sdk = vi.hoisted(() => ({
  ensureAgent: vi.fn(async (_input: { name: string; identifier: string }) => ({ created: false })),
  getContainerConfig: vi.fn(async () => ({
    env: { HTTPS_PROXY: 'http://host.docker.internal:15001' },
    caCertificate: 'fixture-ca',
    caCertificateContainerPath: '/tmp/onecli-ca.pem',
  })),
  startApproval: vi.fn(),
  manualApproval: undefined as undefined | ((request: Record<string, unknown>) => Promise<'approve' | 'deny'>),
  stopApproval: vi.fn(),
}));

vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: class {
    ensureAgent = sdk.ensureAgent;
    getContainerConfig = sdk.getContainerConfig;
  },
  ApprovalClient: class {
    resolve?: () => void;
    start(callback: (request: Record<string, unknown>) => Promise<'approve' | 'deny'>) {
      sdk.manualApproval = callback;
      const running = sdk.startApproval(callback);
      if (running) return running;
      return new Promise<void>((resolve) => {
        this.resolve = resolve;
      });
    }
    stop() {
      sdk.stopApproval();
      this.resolve?.();
    }
  },
}));
vi.mock('../config.js', async (original) => ({
  ...(await original<typeof import('../config.js')>()),
  DATA_DIR: '/tmp/nanoclaw-onecli-adapter-review',
}));

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));
vi.mock('../env.js', () => ({
  readEnvFile: () => ({
    ONECLI_URL: 'http://localhost:1',
    ONECLI_API_KEY: 'unused',
    ANTHROPIC_BASE_URL: 'https://anthropic.example.com',
  }),
}));

import { contributionFromConfig, grantSharedSecretsToNewAgent, withProviderEnv } from './onecli.js';
import { getGatewayProviderRegistration } from './gateway-provider-registry.js';

const provider = getGatewayProviderRegistration('onecli')!;
const scope = { ownsAgentGroup: vi.fn(async (id: string) => id === 'g1') };
const subscribe = (decide: Parameters<typeof provider.approvals.subscribe>[0], signal: AbortSignal) =>
  provider.approvals.subscribe(decide, signal, undefined, scope);
const groupInput = (group: string): GatewaySessionInput => ({
  key: { installSlug: 'install', agentGroupId: group, sessionId: `s-${group}` },
  runtimeIdentity: `install/${group}/s-${group}`,
  groupName: group,
  containerName: 'fixture-agent',
  capabilities: {} as never,
});
const input = (sessionId: string): GatewaySessionInput => ({
  key: { installSlug: 'install', agentGroupId: 'g1', sessionId },
  runtimeIdentity: `install/g1/${sessionId}`,
  groupName: 'Group One',
  containerName: 'fixture-agent',
  capabilities: {} as never,
});

beforeEach(() => {
  vi.clearAllMocks();
  sdk.manualApproval = undefined;
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync('/tmp/nanoclaw-onecli-adapter-review', { recursive: true, force: true });
});

describe('OneCLI gateway package', () => {
  it.each(['copy-a', 'copy-b'])('leaves foreign requests untouched by the real SDK poller: %s', async (owned) => {
    const { ApprovalClient } = await vi.importActual<typeof import('@onecli-sh/sdk')>('@onecli-sh/sdk');
    const controller = new AbortController();
    let client: InstanceType<typeof ApprovalClient>;
    let callbacksSettled = 0;
    sdk.startApproval.mockImplementationOnce((callback) => {
      client = new ApprovalClient('http://fixture.test', '', 'http://fixture.test', null);
      return client.start(async (request) => {
        try {
          return await callback(request);
        } finally {
          callbacksSettled++;
        }
      });
    });
    sdk.stopApproval.mockImplementationOnce(() => client.stop());
    const requests = ['copy-a', 'copy-b'].flatMap((group) =>
      [false, true].map((stale) => ({
        id: `${group}-${stale ? 'stale' : 'fresh'}`,
        createdAt: new Date(stale ? 0 : Date.now() + 1000).toISOString(),
        expiresAt: new Date(Date.now() + 30000).toISOString(),
        method: 'POST',
        host: 'api.example.test',
        path: '/resource',
        agent: { name: group, externalId: group },
      })),
    );
    let polled = false;
    const decisions: Array<{ id: string; decision: string }> = [];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      const endpoint = new URL(String(url));
      if (endpoint.pathname.endsWith('/decision')) {
        decisions.push({ id: endpoint.pathname.split('/')[3], ...JSON.parse(String(options?.body)) });
        return new Response('{}');
      }
      if (!polled) {
        polled = true;
        return Response.json({ requests, timeoutSeconds: 30 });
      }
      return new Promise<Response>((_resolve, reject) => {
        options!.signal!.addEventListener('abort', () => reject(new Error('stopped')), { once: true });
      });
    });
    const decide = vi.fn(async () => 'approve' as const);
    const running = provider.approvals.subscribe(decide, controller.signal, undefined, {
      ownsAgentGroup: async (id: string) => id === owned,
    });
    try {
      await vi.waitFor(() => expect(decisions.length).toBeGreaterThanOrEqual(2));
      await vi.waitFor(() => expect(callbacksSettled).toBe(requests.length));
      expect(decisions.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
        { id: `${owned}-fresh`, decision: 'approve' },
        { id: `${owned}-stale`, decision: 'deny' },
      ]);
      expect(decide).toHaveBeenCalledTimes(1);
    } finally {
      controller.abort();
      await running;
      fetchMock.mockRestore();
    }
  });

  it('submits no decision if installation ownership cannot be read', async () => {
    const controller = new AbortController();
    const decide = vi.fn(async () => 'approve' as const);
    const running = provider.approvals.subscribe(decide, controller.signal, undefined, {
      ownsAgentGroup: async () => {
        throw new Error('ownership unavailable');
      },
    });
    try {
      await vi.waitFor(() => expect(sdk.manualApproval).toBeTypeOf('function'));
      await expect(
        sdk.manualApproval!({
          id: 'foreign',
          createdAt: new Date(0).toISOString(),
          agent: { name: 'other', externalId: 'other' },
        }),
      ).rejects.toThrow('ownership unavailable');
      expect(decide).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      await running;
    }
  });

  it('keeps same-basename stubs separate across destinations and agents on the real filesystem', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onecli-stubs-'));
    try {
      const config = {
        env: {},
        caCertificate: 'CA',
        caCertificateContainerPath: '/tmp/ca.pem',
        credentialStubs: [
          { containerPath: '/first/config.json', content: 'first-stub' },
          { containerPath: '/second/config.json', content: 'second-stub' },
        ],
      };
      const first = contributionFromConfig(config, 'g1', root);
      const second = contributionFromConfig(
        { ...config, credentialStubs: [{ containerPath: '/first/config.json', content: 'other-agent' }] },
        'g2',
        root,
      );
      const a = first.mounts!.find((m) => m.containerPath === '/first/config.json')!;
      const b = first.mounts!.find((m) => m.containerPath === '/second/config.json')!;
      expect(a.hostPath).not.toBe(b.hostPath);
      expect(fs.readFileSync(a.hostPath, 'utf8')).toBe('first-stub');
      expect(fs.readFileSync(b.hostPath, 'utf8')).toBe('second-stub');
      expect(second.mounts!.find((m) => m.containerPath === '/first/config.json')!.hostPath).not.toBe(a.hostPath);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('propagates approval startup failure so core can reconnect', async () => {
    sdk.startApproval.mockImplementationOnce(() => {
      throw new Error('gateway URL unavailable');
    });
    await expect(subscribe(async () => 'deny', new AbortController().signal)).rejects.toThrow(
      'gateway URL unavailable',
    );
    expect(sdk.stopApproval).toHaveBeenCalled();
  });

  it('exposes the pinned SDK gateway discovery rejection through the provider subscription', async () => {
    const { ApprovalClient } = await vi.importActual<typeof import('@onecli-sh/sdk')>('@onecli-sh/sdk');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 503 }));
    sdk.startApproval.mockImplementationOnce((callback) =>
      new ApprovalClient('http://localhost:1', 'fixture', null, null).start(callback),
    );
    try {
      await expect(subscribe(async () => 'deny', new AbortController().signal)).rejects.toThrow(
        'Failed to resolve gateway URL',
      );
      expect(fetchMock).toHaveBeenCalledWith('http://localhost:1/v1/gateway-url', expect.anything());
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('owns endpoint configuration and returns a typed session contribution', async () => {
    const controller = new AbortController();
    const lease = await provider.sessions.ensure(input('s1'), controller.signal);

    expect(sdk.ensureAgent).toHaveBeenCalledWith({ name: 'Group One', identifier: 'g1' });
    expect(sdk.getContainerConfig).toHaveBeenCalledWith({ agent: 'g1' });
    expect(lease.contribution).toMatchObject({
      env: {
        HTTPS_PROXY: 'http://host.docker.internal:15001',
        ANTHROPIC_BASE_URL: 'https://anthropic.example.com',
        ANTHROPIC_AUTH_TOKEN: 'gateway-managed',
      },
      networkAccess: {
        endpoint: 'host.docker.internal',
        target: { kind: 'runtime', identity: 'onecli' },
      },
    });
    expect(withProviderEnv({}, '')).toEqual({});
    controller.abort();
  });

  it('leaves an existing agent alone: no grants are read or written', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const controller = new AbortController();
    try {
      await provider.sessions.ensure(input('s1'), controller.signal);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      fetchMock.mockRestore();
    }
  });

  it('grants the first agent in the project every project secret (the pre-1.44 default)', async () => {
    sdk.ensureAgent.mockResolvedValueOnce({ created: true });
    const gateway = fakeGateway();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(gateway.fetch);
    const controller = new AbortController();
    try {
      await provider.sessions.ensure(input('s1'), controller.signal);
      expect(gateway.calls).toEqual([
        'GET /v1/agents',
        'GET /v1/agents/oc-g1/grants',
        'GET /v1/secrets',
        'PUT /v1/agents/oc-g1/grants/secrets/sec-model',
        'done /v1/agents/oc-g1/grants/secrets/sec-model',
        'PUT /v1/agents/oc-g1/grants/secrets/sec-vercel',
        'done /v1/agents/oc-g1/grants/secrets/sec-vercel',
      ]);
      expect(gateway.auth).toBe('Bearer unused');
      expect(sdk.getContainerConfig).toHaveBeenCalledWith({ agent: 'g1' });
    } finally {
      controller.abort();
      fetchMock.mockRestore();
    }
  });

  const grant = (gateway: ReturnType<typeof fakeGateway>) =>
    grantSharedSecretsToNewAgent('g1', { baseUrl: 'http://gw.test', fetchImpl: gateway.fetch });
  const attached = (gateway: ReturnType<typeof fakeGateway>) =>
    gateway.calls.filter((c) => c.startsWith('PUT ')).map((c) => c.split('/').at(-1));

  it('grants a new agent the secrets every other agent holds, not one only some hold', async () => {
    const gateway = fakeGateway({
      vault: ['sec-model', 'sec-dial'],
      others: [
        { id: 'oc-a', secrets: ['sec-model', 'sec-dial'] },
        { id: 'oc-b', secrets: ['sec-model'] },
      ],
    });
    await expect(grant(gateway)).resolves.toBe(1);
    expect(attached(gateway)).toEqual(['sec-model']);
  });

  it('never attaches a grant that points at a secret no longer in the vault', async () => {
    const gateway = fakeGateway({
      vault: ['sec-model'],
      others: [
        { id: 'oc-a', secrets: ['sec-model', 'sec-gone'] },
        { id: 'oc-b', secrets: ['sec-gone', 'sec-model'] },
      ],
    });
    await expect(grant(gateway)).resolves.toBe(1);
    expect(attached(gateway)).toEqual(['sec-model']);
  });

  it("does not count OneCLI's own default agent when other agents hold secrets", async () => {
    const gateway = fakeGateway({
      others: [
        { id: 'oc-default', secrets: ['sec-model'], isDefault: true },
        { id: 'oc-a', secrets: ['sec-model', 'sec-vercel'] },
      ],
    });
    await expect(grant(gateway)).resolves.toBe(2);
    expect(attached(gateway)).toEqual(['sec-model', 'sec-vercel']);
  });

  it('does not count an agent that holds no secrets', async () => {
    const gateway = fakeGateway({
      others: [
        { id: 'oc-a', secrets: ['sec-model', 'sec-vercel'] },
        { id: 'oc-empty', secrets: [] },
      ],
    });
    await expect(grant(gateway)).resolves.toBe(2);
    expect(attached(gateway)).toEqual(['sec-model', 'sec-vercel']);
  });

  it("with no other agent holding secrets, uses the default agent's secrets (the post-conversion case)", async () => {
    const gateway = fakeGateway({
      others: [
        { id: 'oc-default', secrets: ['sec-model', 'sec-gone'], isDefault: true },
        { id: 'oc-empty', secrets: [] },
      ],
    });
    await expect(grant(gateway)).resolves.toBe(1);
    expect(attached(gateway)).toEqual(['sec-model']);
  });

  it('on a fresh gateway (default agent empty, no other agent) attaches every vault secret', async () => {
    const gateway = fakeGateway({ others: [{ id: 'oc-default', secrets: [], isDefault: true }] });
    await expect(grant(gateway)).resolves.toBe(2);
    expect(attached(gateway)).toEqual(['sec-model', 'sec-vercel']);
  });

  it('two different new groups spawning at once, then a third, all get the pre-existing shared set', async () => {
    const world = statefulGateway({
      vault: ['sec-model', 'sec-vercel', 'sec-dial'],
      agents: [
        { identifier: 'default', isDefault: true, secrets: [] },
        { identifier: 'n1', secrets: ['sec-model', 'sec-vercel'] },
      ],
      putDelayMs: 15,
    });
    sdk.ensureAgent.mockImplementation(world.ensureAgent);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(world.fetch);
    const controllers: AbortController[] = [];
    const spawn = (group: string) => {
      const c = new AbortController();
      controllers.push(c);
      return provider.sessions.ensure(groupInput(group), c.signal);
    };
    try {
      // p2 starts while p1 holds only part of its grants.
      const first = spawn('p1');
      await world.firstPut;
      await Promise.all([first, spawn('p2')]);
      await spawn('n3');
      for (const group of ['p1', 'p2', 'n3']) expect(world.held(group)).toEqual(['sec-model', 'sec-vercel']);
    } finally {
      controllers.forEach((c) => c.abort());
      fetchMock.mockRestore();
      sdk.ensureAgent.mockImplementation(async (_input: { name: string; identifier: string }) => ({ created: false }));
    }
  });

  it("fails and deletes the new agent when another agent's grants cannot be read", async () => {
    const gateway = fakeGateway({
      others: [
        { id: 'oc-a', secrets: ['sec-model'] },
        { id: 'oc-b', secrets: [], grantsStatus: 500 },
      ],
    });
    await expect(grant(gateway)).rejects.toThrow(/oc-b\/grants returned 500.*the agent was deleted/);
    expect(attached(gateway)).toEqual([]);
    expect(gateway.calls.at(-1)).toBe('DELETE /v1/agents/oc-g1');
  });

  it('attaches nothing on a gateway without the grants API, where a new agent is already in all mode', async () => {
    const gateway = fakeGateway({ grantsStatus: 404, grantsBody: UNKNOWN_ROUTE_404 });
    await expect(
      grantSharedSecretsToNewAgent('g1', { baseUrl: 'http://gw.test/', fetchImpl: gateway.fetch }),
    ).resolves.toBeNull();
    expect(gateway.calls).toEqual(['GET /v1/agents', 'GET /v1/agents/oc-g1/grants']);
  });

  it('treats any other grants 404 (agent not found) as a failure, not as a gateway without grants', async () => {
    const gateway = fakeGateway({ grantsStatus: 404, grantsBody: AGENT_NOT_FOUND_404 });
    await expect(
      grantSharedSecretsToNewAgent('g1', { baseUrl: 'http://gw.test', fetchImpl: gateway.fetch }),
    ).rejects.toThrow(/returned 404/);
    expect(gateway.calls).not.toContain('GET /v1/secrets');
  });

  it('a concurrent spawn for a new group returns only after the creator has attached the grants', async () => {
    sdk.ensureAgent.mockResolvedValueOnce({ created: true });
    const gateway = fakeGateway({ putDelayMs: 20 });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(gateway.fetch);
    const first = new AbortController();
    const second = new AbortController();
    try {
      await Promise.all([
        provider.sessions.ensure(input('s1'), first.signal).then(() => gateway.calls.push('ready s1')),
        provider.sessions.ensure(input('s2'), second.signal).then(() => gateway.calls.push('ready s2')),
      ]);
      const lastGrant = gateway.calls.lastIndexOf('done /v1/agents/oc-g1/grants/secrets/sec-vercel');
      expect(lastGrant).toBeGreaterThan(-1);
      expect(gateway.calls.indexOf('ready s2')).toBeGreaterThan(lastGrant);
      expect(sdk.ensureAgent).toHaveBeenCalledTimes(1);
    } finally {
      first.abort();
      second.abort();
      fetchMock.mockRestore();
    }
  });

  it('a failed first-time grant fails every concurrent spawn for the group and deletes the agent once', async () => {
    sdk.ensureAgent.mockResolvedValueOnce({ created: true });
    const gateway = fakeGateway({ putStatus: 500, putDelayMs: 20 });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(gateway.fetch);
    const first = new AbortController();
    const second = new AbortController();
    try {
      const results = await Promise.allSettled([
        provider.sessions.ensure(input('s1'), first.signal),
        provider.sessions.ensure(input('s2'), second.signal),
      ]);
      expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
      expect(gateway.calls.filter((c) => c === 'DELETE /v1/agents/oc-g1')).toHaveLength(1);
      expect(sdk.getContainerConfig).not.toHaveBeenCalled();
    } finally {
      first.abort();
      second.abort();
      fetchMock.mockRestore();
    }
  });

  it('deletes the new agent and fails the spawn when a grant cannot be written', async () => {
    const gateway = fakeGateway({ putStatus: 500 });
    await expect(
      grantSharedSecretsToNewAgent('g1', { baseUrl: 'http://gw.test', fetchImpl: gateway.fetch }),
    ).rejects.toThrow(/the agent was deleted, so the next spawn creates it and retries/);
    expect(gateway.calls.at(-1)).toBe('DELETE /v1/agents/oc-g1');
  });

  it('names the manual cleanup when the new agent cannot be deleted either', async () => {
    const gateway = fakeGateway({ putStatus: 500, deleteStatus: 500 });
    await expect(
      grantSharedSecretsToNewAgent('g1', { baseUrl: 'http://gw.test', fetchImpl: gateway.fetch }),
    ).rejects.toThrow('onecli agents delete --id oc-g1');
  });

  it('shares one health monitor across live leases and reports failure to each session', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = await provider.sessions.ensure(input('s1'), firstController.signal);
    const second = await provider.sessions.ensure(input('s2'), secondController.signal);
    const unavailable = vi.fn();
    first.onUnavailable?.(unavailable);
    second.onUnavailable?.(unavailable);

    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(unavailable).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);

    firstController.abort();
    secondController.abort();
    fetchMock.mockRestore();
  });

  it('translates native approvals once and stops the subscription on cancellation', async () => {
    const decide = vi.fn(async (_request: GatewayApprovalRequest) => 'approve' as const);
    const controller = new AbortController();
    const subscription = subscribe(decide, controller.signal);
    await vi.waitFor(() => expect(sdk.manualApproval).toBeTypeOf('function'));
    const createdAt = new Date(Date.now() + 1_000).toISOString();

    await expect(
      sdk.manualApproval!({
        id: 'native-1',
        createdAt,
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
        method: 'POST',
        host: 'api.example.test',
        path: '/resource',
        bodyPreview: '{"safe":"preview","mention":"<@U123>"}',
        agent: { name: 'Group <@U123>', externalId: 'g1' },
      }),
    ).resolves.toBe('approve');
    expect(decide).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'native-1',
        trigger: 'policy',
        destination: { host: 'api.example.test', method: 'POST' },
        agentGroupId: 'g1',
        createdAt,
        title: 'Credentials Request',
        audit: { method: 'POST', host: 'api.example.test', path: '/resource' },
      }),
    );
    expect(decide.mock.calls[0][0].question).not.toContain('<@U123>');

    await expect(
      sdk.manualApproval!({
        id: 'stale',
        createdAt: new Date(0).toISOString(),
        method: 'GET',
        host: 'api.example.test',
        path: '/',
        agent: { name: 'Group One', externalId: 'g1' },
      }),
    ).resolves.toBe('deny');
    expect(decide).toHaveBeenCalledTimes(1);

    controller.abort();
    await subscription;
    expect(sdk.stopApproval).toHaveBeenCalledOnce();
  });
});

const compatibilityFixtures = JSON.parse(fs.readFileSync('gateway-compat/onecli-summary/fixtures.json', 'utf8')) as {
  name: string;
  request: { host: string; method: string; path: string };
  summary: { action: string; details: { label: string; value: string }[] };
}[];

it.each(compatibilityFixtures)('preserves native OneCLI approval content: $name', async (fixture) => {
  const decide = vi.fn(async (_request: GatewayApprovalRequest) => 'deny' as const);
  const controller = new AbortController();
  const subscription = subscribe(decide, controller.signal);
  await vi.waitFor(() => expect(sdk.manualApproval).toBeTypeOf('function'));
  await sdk.manualApproval!({
    id: 'native-fixture',
    createdAt: new Date(Date.now() + 1000).toISOString(),
    expiresAt: new Date(Date.now() + 30000).toISOString(),
    ...fixture.request,
    summary: fixture.summary,
    agent: { name: 'Nano', externalId: 'g1' },
  });
  expect(decide.mock.calls[0][0].summary).toEqual({
    agent: 'Nano',
    action: fixture.summary.action,
    details: fixture.summary.details,
    resource: `${fixture.request.method} ${fixture.request.host}${fixture.request.path}`,
    reason: 'The gateway policy requires human approval for this request.',
  });
  controller.abort();
  await subscription;
});

const UNKNOWN_ROUTE_404 = {
  error: {
    message:
      'Unrecognized request URL (GET: /v1/agents/oc-g1/grants). Please see https://onecli.sh/docs/api-reference for available endpoints.',
    type: 'invalid_request_error',
  },
};
const AGENT_NOT_FOUND_404 = { error: { message: 'Agent not found.', type: 'not_found_error' } };

function fakeGateway(
  opts: {
    grantsStatus?: number;
    grantsBody?: unknown;
    putStatus?: number;
    putDelayMs?: number;
    deleteStatus?: number;
    /** Agents besides the new one (oc-g1), with the secret ids each holds. */
    others?: Array<{ id: string; secrets: string[]; isDefault?: boolean; grantsStatus?: number }>;
    /** Secret ids in the vault. */
    vault?: string[];
  } = {},
) {
  const calls: string[] = [];
  let auth: string | undefined;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const { pathname } = new URL(String(url));
    const method = init?.method ?? 'GET';
    auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    calls.push(`${method} ${pathname}`);
    const others = opts.others ?? [];
    if (pathname === '/v1/agents')
      return json([
        { id: 'oc-g1', identifier: 'g1' },
        ...others.map((o) => ({ id: o.id, identifier: o.id, isDefault: o.isDefault ?? false })),
      ]);
    const other = others.find((o) => pathname === `/v1/agents/${o.id}/grants`);
    if (other && method === 'GET')
      return json(
        { mode: 'grants', connections: [], secrets: other.secrets.map((secretId) => ({ secretId })) },
        other.grantsStatus,
      );
    if (pathname === '/v1/agents/oc-g1/grants')
      return json(opts.grantsBody ?? { mode: 'grants', secrets: [] }, opts.grantsStatus);
    if (pathname === '/v1/secrets') return json((opts.vault ?? ['sec-model', 'sec-vercel']).map((id) => ({ id })));
    if (method === 'PUT') {
      if (opts.putDelayMs) await new Promise((r) => setTimeout(r, opts.putDelayMs));
      calls.push(`done ${pathname}`);
      return json({}, opts.putStatus);
    }
    if (method === 'DELETE') return new Response(null, { status: opts.deleteStatus ?? 204 });
    return json({ error: 'unexpected' }, 500);
  }) as typeof fetch;
  return {
    calls,
    fetch: fetchImpl,
    get auth() {
      return auth;
    },
  };
}

/** A gateway whose agents and grants change as the adapter creates, attaches and deletes. */
function statefulGateway(opts: {
  vault: string[];
  agents: Array<{ identifier: string; secrets: string[]; isDefault?: boolean }>;
  putDelayMs?: number;
}) {
  const agents = new Map(
    opts.agents.map((a) => [`oc-${a.identifier}`, { ...a, id: `oc-${a.identifier}`, secrets: new Set(a.secrets) }]),
  );
  let putApplied: () => void = () => {};
  const firstPut = new Promise<void>((resolve) => (putApplied = resolve));
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const { pathname } = new URL(String(url));
    const method = init?.method ?? 'GET';
    if (pathname === '/v1/agents' && method === 'GET')
      return json([...agents.values()].map((a) => ({ id: a.id, identifier: a.identifier, isDefault: !!a.isDefault })));
    if (pathname === '/v1/secrets') return json(opts.vault.map((id) => ({ id })));
    const m = /^\/v1\/agents\/([^/]+)(\/grants(?:\/secrets\/([^/]+))?)?$/.exec(pathname);
    const agent = m ? agents.get(decodeURIComponent(m[1])) : undefined;
    if (!agent) return json({ error: { message: 'Agent not found.', type: 'not_found_error' } }, 404);
    if (m![2] && !m![3] && method === 'GET')
      return json({ mode: 'grants', connections: [], secrets: [...agent.secrets].map((secretId) => ({ secretId })) });
    if (m![3] && method === 'PUT') {
      if (opts.putDelayMs) await new Promise((r) => setTimeout(r, opts.putDelayMs));
      agent.secrets.add(decodeURIComponent(m![3]));
      putApplied();
      return json({});
    }
    if (!m![2] && method === 'DELETE') {
      agents.delete(agent.id);
      return new Response(null, { status: 204 });
    }
    return json({ error: 'unexpected' }, 500);
  }) as typeof fetch;
  return {
    fetch: fetchImpl,
    firstPut,
    ensureAgent: async ({ identifier }: { identifier: string }) => {
      const id = `oc-${identifier}`;
      if (agents.has(id)) return { created: false };
      agents.set(id, { identifier, id, secrets: new Set<string>() });
      return { created: true };
    },
    held: (identifier: string) => [...(agents.get(`oc-${identifier}`)?.secrets ?? [])].sort(),
  };
}
