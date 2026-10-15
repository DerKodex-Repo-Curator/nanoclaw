/**
 * This install's record of the OneCLI secrets its provider logins saved, by
 * agent provider name. A group is granted the ones for the provider it runs;
 * every other secret is attached only by the skill that adds it. Ids are per
 * install, so installs sharing one gateway never pick up each other's logins.
 * Imported by the skill's setup scripts as well, so it uses node builtins only.
 */
import fs from 'node:fs';
import path from 'node:path';

export type ProviderCredentialRecord = Record<string, string[]>;

export function providerCredentialFile(dataDir: string): string {
  return path.join(dataDir, 'onecli', 'provider-credentials.json');
}

/** A missing file is an empty record; an unreadable one throws rather than guess. */
export function readProviderCredentials(dataDir: string): ProviderCredentialRecord {
  const file = providerCredentialFile(dataDir);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  const parsed = JSON.parse(raw) as unknown;
  const valid =
    parsed !== null &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    Object.values(parsed).every((ids) => Array.isArray(ids) && ids.every((id) => typeof id === 'string'));
  if (!valid) throw new Error(`${file} must map provider names to lists of OneCLI secret ids`);
  return parsed as ProviderCredentialRecord;
}

/** Adds ids to a provider's entry, or replaces the entry; written atomically. */
export function recordProviderCredentials(
  dataDir: string,
  provider: string,
  ids: string[],
  opts: { replace?: boolean } = {},
): void {
  const record = readProviderCredentials(dataDir);
  record[provider] = [...new Set([...(opts.replace ? [] : (record[provider] ?? [])), ...ids])];
  const file = providerCredentialFile(dataDir);
  // Mode 0700 matches the staged-file directory this shares.
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

// The names NanoClaw's provider setup gives the secrets it saves. Matched only
// for a provider with no live recorded id (logins saved before ids were kept,
// or a save interrupted before it recorded), and the matches are then recorded.
const SAVED_NAMES: Record<string, (name: string) => boolean> = {
  claude: (name) => name === 'Anthropic',
  codex: (name) => /^(codex|openai)$/i.test(name),
  opencode: (name) => name.startsWith('OpenCode '),
};

export function isSavedProviderCredentialName(provider: string, name: unknown): boolean {
  return typeof name === 'string' && (SAVED_NAMES[provider]?.(name) ?? false);
}

/** Pulls the secret id out of `onecli secrets create` output (JSON, possibly with a `hint` key). */
export function createdSecretId(output: string): string | null {
  try {
    const parsed = JSON.parse(output) as { id?: unknown; data?: { id?: unknown } };
    const id = parsed.id ?? parsed.data?.id;
    return typeof id === 'string' && id ? id : null;
  } catch {
    return null;
  }
}
