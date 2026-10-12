// Behavior tests for /add-vercel's OneCLI steps: the shell blocks that grant the
// Vercel secret to agents (SKILL.md) and take it away again (REMOVE.md).
//
// The blocks are taken out of the documents and run under `sh` against a stub
// `onecli` that logs every call, so the assertions read the exact commands the
// skill issues. OneCLI 1.44+ answers `410 Gone` on the old per-agent list API
// (`agents secrets` / `agents set-secrets`), so the skill must use the grants
// API: one attach (or detach) per agent, never a read-merge-write of the list.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SKILL_DIR = path.resolve(__dirname, '../.claude/skills/add-vercel');

/** The first ```bash block after `heading` in `file`. */
function block(file: string, heading: string): string {
  const doc = fs.readFileSync(path.join(SKILL_DIR, file), 'utf8');
  const start = doc.indexOf(heading);
  if (start < 0) throw new Error(`${file}: heading not found: ${heading}`);
  const m = /```bash\n([\s\S]*?)```/.exec(doc.slice(start));
  if (!m) throw new Error(`${file}: no bash block after ${heading}`);
  return m[1];
}

const ATTACH = block('SKILL.md', '### Assign the secret to all agents');
const DETACH = block('REMOVE.md', '## 3. Remove the OneCLI credential');

let root: string;
let calls: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'add-vercel-onecli-'));
  calls = path.join(root, 'calls.log');
  fs.writeFileSync(calls, '');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, 'onecli'),
    `#!/usr/bin/env bash
echo "onecli $*" >> "$CALLS"
case "$1 $2" in
  "secrets list") echo '{"data":[{"id":"sec-model","name":"Anthropic"},{"id":"sec-vercel","name":"Vercel API Token"}]}' ;;
  "agents list") echo '{"data":[{"id":"oc-default","identifier":"default"},{"id":"oc-sales","identifier":"ag-sales"}]}' ;;
  "agents secrets"|"agents set-secrets") echo '{"error":"removed","code":"GONE"}'; exit 1 ;;
  *) echo '{}' ;;
esac
`,
    { mode: 0o755 },
  );
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function run(script: string): string[] {
  execFileSync('sh', ['-c', script], {
    cwd: root,
    env: { ...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH}`, CALLS: calls },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return fs.readFileSync(calls, 'utf8').trim().split('\n');
}

describe('/add-vercel OneCLI steps', () => {
  it('attaches the Vercel secret to every agent through the grants API', () => {
    const lines = run(ATTACH);
    expect(lines).toContain('onecli agents grants attach-secret --id oc-default --secret-id sec-vercel');
    expect(lines).toContain('onecli agents grants attach-secret --id oc-sales --secret-id sec-vercel');
    expect(lines.filter((l) => l.includes('grants attach-secret'))).toHaveLength(2);
  });

  it('removal detaches the Vercel secret from every agent, then deletes it', () => {
    const lines = run(DETACH);
    expect(lines).toContain('onecli agents grants detach-secret --id oc-default --secret-id sec-vercel');
    expect(lines).toContain('onecli agents grants detach-secret --id oc-sales --secret-id sec-vercel');
    expect(lines.at(-1)).toBe('onecli secrets delete --id sec-vercel');
  });

  it.each([
    ['apply', ATTACH],
    ['removal', DETACH],
  ])('%s never uses the per-agent list API that OneCLI 1.44+ removed', (_name, script) => {
    const lines = run(script);
    expect(lines.some((l) => /onecli agents (set-secrets|secrets)\b/.test(l))).toBe(false);
  });
});
