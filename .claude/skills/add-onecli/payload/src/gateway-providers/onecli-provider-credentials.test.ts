import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createdSecretId,
  isSavedProviderCredentialName,
  providerCredentialFile,
  readProviderCredentials,
  recordProviderCredentials,
} from './onecli-provider-credentials.js';

let data: string;
beforeEach(() => {
  data = fs.mkdtempSync(path.join(os.tmpdir(), 'onecli-record-'));
});
afterEach(() => fs.rmSync(data, { recursive: true, force: true }));

describe('OneCLI provider credential record', () => {
  it('starts empty, adds ids per provider without duplicates, and replaces on request', () => {
    expect(readProviderCredentials(data)).toEqual({});
    recordProviderCredentials(data, 'claude', ['a']);
    recordProviderCredentials(data, 'claude', ['a', 'b']);
    recordProviderCredentials(data, 'codex', ['c']);
    expect(readProviderCredentials(data)).toEqual({ claude: ['a', 'b'], codex: ['c'] });
    recordProviderCredentials(data, 'claude', ['d'], { replace: true });
    expect(readProviderCredentials(data)).toEqual({ claude: ['d'], codex: ['c'] });
  });

  it('keeps the file private and its directory usable for staged OneCLI files (0700)', () => {
    recordProviderCredentials(data, 'claude', ['a']);
    expect(fs.statSync(providerCredentialFile(data)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(providerCredentialFile(data))).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(path.dirname(providerCredentialFile(data)))).toEqual(['provider-credentials.json']);
  });

  it.each(['[]', '{"claude":"a"}', '{"claude":[1]}', 'not json'])('rejects a malformed record: %s', (raw) => {
    fs.mkdirSync(path.dirname(providerCredentialFile(data)), { recursive: true });
    fs.writeFileSync(providerCredentialFile(data), raw);
    expect(() => readProviderCredentials(data)).toThrow();
    expect(() => recordProviderCredentials(data, 'claude', ['a'])).toThrow();
  });

  it('matches only the names NanoClaw provider setup writes', () => {
    expect(isSavedProviderCredentialName('claude', 'Anthropic')).toBe(true);
    expect(isSavedProviderCredentialName('claude', 'Anthropic Dial')).toBe(false);
    expect(isSavedProviderCredentialName('codex', 'Codex')).toBe(true);
    expect(isSavedProviderCredentialName('codex', 'openai')).toBe(true);
    expect(isSavedProviderCredentialName('codex', 'OpenCode ChatGPT')).toBe(false);
    expect(isSavedProviderCredentialName('opencode', 'OpenCode ChatGPT')).toBe(true);
    expect(isSavedProviderCredentialName('opencode', 'OpenCode openrouter')).toBe(true);
    expect(isSavedProviderCredentialName('opencode', 'Vercel API Token')).toBe(false);
    expect(isSavedProviderCredentialName('ollama', 'Anthropic')).toBe(false);
    expect(isSavedProviderCredentialName('claude', undefined)).toBe(false);
  });

  it('reads the id from `onecli secrets create` output, with or without a hint', () => {
    expect(createdSecretId('{"id":"sec-1","name":"Codex"}')).toBe('sec-1');
    expect(createdSecretId('{\n  "hint": "next: attach",\n  "id": "sec-2"\n}')).toBe('sec-2');
    expect(createdSecretId('{"data":{"id":"sec-3"}}')).toBe('sec-3');
    expect(createdSecretId('Done.')).toBeNull();
    expect(createdSecretId('{"id":""}')).toBeNull();
  });
});
