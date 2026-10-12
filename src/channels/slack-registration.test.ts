/**
 * Integration test for the slack channel's single reach-in: the self-registration
 * import in the `src/channels/index.ts` barrel. Importing the barrel runs slack.ts's
 * top-level `registerChannelAdapter('slack', …)`; without the import the channel is
 * silently absent.
 *
 * Behavior, not structural: it imports the real barrel and asserts the registry
 * actually contains the channel. This reflects what happens at host boot — if the
 * `import './slack.js';` line is deleted, or the barrel fails to evaluate for any
 * reason (so the channel genuinely would not register), this goes red. A structural
 * check of the import line would falsely pass in that second case.
 *
 * Importing the barrel is safe: registration is a pure top-level call, and slack.ts
 * builds the SDK adapter / bridge only inside its factory (invoked at host startup),
 * never at import. It does require the adapter package to be installed, which holds
 * in a composed install: the skill's `pnpm install` step runs before this test.
 *
 * Note on the Chat SDK family: slack.ts also consumes a load-bearing *core* API —
 * `createChatSdkBridge(...)` from ./chat-sdk-bridge.js — with a specific options
 * shape. That core-consumption is a typed call, so the build/typecheck leg
 * (`pnpm run build`) guards it against upstream drift, not this test. Every Chat SDK
 * channel (discord, telegram, teams, gchat, webex, …) follows this same shape:
 * swap the channel name below and the adapter package in the build.
 *
 * This file also covers resolveSlackConversation — the adapter-level
 * conversation classifier (direct / group_dm / channel) that consumers like
 * approval cards render from. It is a pure function over an injected
 * SlackAdapter, so it is driven here with mocks; no live API is touched.
 */
import crypto from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';

import type { SlackAdapter } from '@chat-adapter/slack';
import { afterAll, afterEach, beforeAll, beforeEach, describe, it, expect, vi } from 'vitest';

import { registerWebhookAdapter } from '../webhook-server.js';
import type { ChannelAdapter, InboundMessage } from './adapter.js';
import { getRegisteredChannelNames } from './channel-registry.js';
import { createSlackBridge, resolveSlackConversation, slackAuthorIsBot } from './slack.js';
import './index.js'; // the real barrel — triggers every channel's self-registration

const SIGNING_SECRET = vi.hoisted(() => 'test-signing-secret');

vi.mock('../webhook-server.js', () => ({ registerWebhookAdapter: vi.fn() }));
// Only the Slack bridge's read is faked: webhook mode, no app token.
vi.mock('../env.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../env.js')>();
  return {
    ...real,
    readEnvFile: (keys: string[]) =>
      keys.includes('SLACK_BOT_TOKEN')
        ? { SLACK_BOT_TOKEN: 'xoxb-test', SLACK_SIGNING_SECRET: SIGNING_SECRET }
        : real.readEnvFile(keys),
  };
});

describe('slack channel registration', () => {
  it('registers slack via the channel barrel', () => {
    expect(getRegisteredChannelNames()).toContain('slack');
  });
});

describe('slackAuthorIsBot', () => {
  it('answers from the cached user, and null when the lookup finds no one', async () => {
    const getUser = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ isBot: true })
      .mockResolvedValueOnce({ isBot: false });
    const adapter = { getUser } as unknown as SlackAdapter;

    await expect(slackAuthorIsBot(adapter, 'U1')).resolves.toBeNull();
    await expect(slackAuthorIsBot(adapter, 'U2')).resolves.toBe(true);
    await expect(slackAuthorIsBot(adapter, 'U3')).resolves.toBe(false);
    expect(getUser).toHaveBeenLastCalledWith('U3');
  });
});

describe('resolveSlackConversation', () => {
  it('preserves direct messages, channel names, and the API-failure fallback', async () => {
    const fetchThread = vi
      .fn()
      .mockResolvedValueOnce({ channelName: 'general', metadata: { channel: {} } })
      .mockRejectedValueOnce(new Error('slack unavailable'));
    const adapter = { fetchThread } as unknown as SlackAdapter;

    await expect(resolveSlackConversation(adapter, 'slack:D123')).resolves.toEqual({
      type: 'direct',
      name: null,
    });
    expect(fetchThread).not.toHaveBeenCalled();
    await expect(resolveSlackConversation(adapter, 'C123')).resolves.toEqual({
      type: 'channel',
      name: 'general',
    });
    expect(fetchThread).toHaveBeenLastCalledWith('slack:C123');
    // API failure resolves null so the caller falls through to its generic rendering.
    await expect(resolveSlackConversation(adapter, 'slack:C456')).resolves.toBeNull();
  });

  it('carries no participant arrays on direct and channel results', async () => {
    const adapter = {
      fetchThread: vi.fn().mockResolvedValue({ channelName: 'general', metadata: { channel: {} } }),
    } as unknown as SlackAdapter;

    const direct = await resolveSlackConversation(adapter, 'slack:D123');
    expect(direct).not.toHaveProperty('participantNames');
    expect(direct).not.toHaveProperty('participantIds');
    const channel = await resolveSlackConversation(adapter, 'slack:C123');
    expect(channel).not.toHaveProperty('participantNames');
    expect(channel).not.toHaveProperty('participantIds');
  });

  it('resolves MPDM human participants and keeps the type when member lookup fails', async () => {
    const members = vi
      .fn()
      .mockResolvedValueOnce({ members: ['U1', 'U2', 'UBOT'] })
      .mockRejectedValueOnce(new Error('missing scope'));
    const adapter = {
      fetchThread: vi.fn().mockResolvedValue({
        channelName: 'mpdm-avital--omri--avi-1',
        metadata: { channel: { is_mpim: true } },
      }),
      webClient: { conversations: { members } },
      getUser: vi.fn(async (id: string) => ({
        userName: id === 'U1' ? 'Avital' : id === 'U2' ? 'Omri' : 'Avi',
        fullName: id,
        isBot: id === 'UBOT',
        userId: id,
      })),
    } as unknown as SlackAdapter;

    await expect(resolveSlackConversation(adapter, 'slack:G123')).resolves.toEqual({
      type: 'group_dm',
      name: null,
      participantNames: ['Avital', 'Omri'],
      participantIds: ['U1', 'U2'],
    });
    expect(members).toHaveBeenCalledWith({ channel: 'G123', limit: 100 });
    await expect(resolveSlackConversation(adapter, 'G123')).resolves.toEqual({
      type: 'group_dm',
      name: null,
    });
  });

  // participantIds must be raw Slack ids ("U…"), same length and same order
  // as participantNames, with bots removed from BOTH arrays. A consumer
  // pairing the arrays positionally (e.g. excluding one participant by id)
  // breaks silently on a one-sided filter, so the invariant is pinned here.
  it('keeps participantIds parallel to participantNames when bots are filtered', async () => {
    const adapter = {
      fetchThread: vi.fn().mockResolvedValue({ metadata: { channel: { is_mpim: true } } }),
      webClient: {
        conversations: {
          members: vi.fn().mockResolvedValue({ members: ['UBOT1', 'U1', 'UBOT2', 'U2', 'U3'] }),
        },
      },
      getUser: vi.fn(async (id: string) => ({
        userName: `name-${id}`,
        fullName: id,
        isBot: id.startsWith('UBOT'),
        userId: id,
      })),
    } as unknown as SlackAdapter;

    const resolved = await resolveSlackConversation(adapter, 'slack:G777');
    expect(resolved?.type).toBe('group_dm');
    expect(resolved?.participantNames).toEqual(['name-U1', 'name-U2', 'name-U3']);
    expect(resolved?.participantIds).toEqual(['U1', 'U2', 'U3']);
    expect(resolved?.participantIds).toHaveLength(resolved?.participantNames?.length ?? -1);
  });

  it('drops a participant whose profile lookup fails from BOTH arrays', async () => {
    const adapter = {
      fetchThread: vi.fn().mockResolvedValue({ metadata: { channel: { is_mpim: true } } }),
      webClient: {
        conversations: { members: vi.fn().mockResolvedValue({ members: ['U1', 'UGONE', 'U3'] }) },
      },
      // UGONE's profile lookup fails (deactivated user / users:read gap) —
      // getUser resolves null. The member must vanish from names AND ids
      // together, never from just one array.
      getUser: vi.fn(async (id: string) =>
        id === 'UGONE' ? null : { userName: `name-${id}`, fullName: id, isBot: false, userId: id },
      ),
    } as unknown as SlackAdapter;

    const resolved = await resolveSlackConversation(adapter, 'slack:G888');
    expect(resolved).toEqual({
      type: 'group_dm',
      name: null,
      participantNames: ['name-U1', 'name-U3'],
      participantIds: ['U1', 'U3'],
    });
  });
});

/**
 * The workspace ids, end to end: a signed webhook (or a Socket Mode envelope)
 * into createSlackBridge's adapter, out of the bridge's onInbound. Slack's Web
 * API is a local stub, so nothing leaves the machine.
 */
describe('Slack workspaces on inbound messages', () => {
  let api: http.Server;
  let bridge: ChannelAdapter;
  let chat: { webhooks: Record<string, (r: Request) => Promise<Response>>; getAdapter(name: string): unknown };
  const received: InboundMessage[] = [];

  beforeAll(async () => {
    api = http.createServer((_req, res) => res.end('{"ok":true}'));
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    process.env.SLACK_API_URL = `http://127.0.0.1:${(api.address() as AddressInfo).port}/api/`;
  });

  afterAll(() => {
    api.close();
    delete process.env.SLACK_API_URL;
  });

  beforeEach(async () => {
    const { initTestDb } = await import('../db/connection.js');
    const { runMigrations } = await import('../db/migrations/index.js');
    await runMigrations(await initTestDb());
    received.length = 0;
    vi.mocked(registerWebhookAdapter).mockClear();
    bridge = createSlackBridge()!;
    await bridge.setup({
      onInbound: (_platformId, _threadId, message) => {
        received.push(message);
      },
      onInboundEvent: () => {},
      onMetadata: () => {},
      onAction: () => {},
    });
    chat = vi.mocked(registerWebhookAdapter).mock.calls[0][0] as unknown as typeof chat;
  });

  afterEach(async () => {
    await bridge.teardown();
    const { closeDb } = await import('../db/connection.js');
    await closeDb();
  });

  let ts = 0;
  function envelope(event: Record<string, unknown>, installTeam?: string) {
    return {
      type: 'event_callback',
      team_id: 'T0HOST',
      event: { type: 'message', channel: 'D0DM', channel_type: 'im', ts: `1.${++ts}`, user: 'U0SENDER', ...event },
      ...(installTeam ? { authorizations: [{ team_id: installTeam, user_id: 'U0BOT', is_bot: true }] } : {}),
    };
  }

  async function viaWebhook(payload: unknown): Promise<InboundMessage> {
    const body = JSON.stringify(payload);
    const at = String(Math.floor(Date.now() / 1000));
    const sig = 'v0=' + crypto.createHmac('sha256', SIGNING_SECRET).update(`v0:${at}:${body}`).digest('hex');
    const res = await chat.webhooks.slack(
      new Request('http://localhost/webhook/slack', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-slack-signature': sig, 'x-slack-request-timestamp': at },
        body,
      }),
    );
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(received).toHaveLength(1));
    return received[0];
  }

  async function viaSocket(payload: unknown): Promise<InboundMessage> {
    const adapter = chat.getAdapter('slack') as {
      routeSocketEvent(body: unknown, type: string, ack: () => Promise<void>): Promise<void>;
    };
    await adapter.routeSocketEvent(payload, 'events_api', async () => {});
    await vi.waitFor(() => expect(received).toHaveLength(1));
    return received[0];
  }

  it("webhook: the sender's team from the event (user_team over team), the bot's from authorizations", async () => {
    const message = await viaWebhook(envelope({ team: 'T0OURS', user_team: 'T0PARTNER' }, 'T0OURS'));
    expect(message.workspace).toEqual({ sender: 'T0PARTNER', bot: 'T0OURS' });
  });

  it("Socket Mode: the bot's team survives the adapter rebuilding the envelope without authorizations", async () => {
    const message = await viaSocket(envelope({ team: 'T0OURS' }, 'T0OURS'));
    expect(message.workspace).toEqual({ sender: 'T0OURS', bot: 'T0OURS' });
  });

  it("never takes the envelope's team_id for the bot's, and is unset when the event names no team", async () => {
    expect((await viaWebhook(envelope({ team: 'T0HOST' }))).workspace).toEqual({ sender: 'T0HOST', bot: undefined });
    received.length = 0;
    expect((await viaWebhook(envelope({}))).workspace).toBeUndefined();
  });
});
