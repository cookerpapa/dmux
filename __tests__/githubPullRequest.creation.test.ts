import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { createGitHubPullRequest, getPreferredPushRemote } from '../src/utils/githubPullRequest.js';

interface CommandResponse {
  command: string;
  args: string[];
  stdout?: string;
  stderr?: string;
  status?: number;
  waitForHeartbeat?: boolean;
}

// Run real child processes without contacting GitHub or changing a repository.
const commandFixture = `#!${process.execPath}
const fs = require('fs');
const path = require('path');
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const responses = JSON.parse(fs.readFileSync('responses.json', 'utf8'));
const response = responses.shift();
fs.writeFileSync('responses.json', JSON.stringify(responses));
if (!response || response.command !== command || JSON.stringify(response.args) !== JSON.stringify(args)) {
  process.stderr.write('Unexpected command: ' + JSON.stringify({ command, args }));
  process.exit(99);
}
function finish() {
  process.stdout.write(response.stdout || '');
  process.stderr.write(response.stderr || '');
  process.exit(response.status || 0);
}
if (response.waitForHeartbeat) {
  fs.writeFileSync('command-pending', '');
  const deadline = Date.now() + 2000;
  const timer = setInterval(() => {
    if (fs.existsSync('heartbeat') || Date.now() >= deadline) {
      clearInterval(timer);
      fs.writeFileSync('responsive.json', JSON.stringify(fs.existsSync('heartbeat')));
      fs.unlinkSync('command-pending');
      finish();
    }
  }, 10);
} else {
  finish();
}
`;

describe.skipIf(process.platform === 'win32')('GitHub PR commands', () => {
  let repoPath: string;
  const sourceBranch = 'feature/review-queue';
  const url = 'https://github.com/acme/repo/pull/123';
  const version: CommandResponse = { command: 'gh', args: ['--version'], stdout: 'gh version 2.0' };
  const view: CommandResponse = {
    command: 'gh', args: ['pr', 'view', sourceBranch, '--json', 'url', '--jq', '.url'],
  };
  const remote: CommandResponse = {
    command: 'git', args: ['ls-remote', '--heads', 'origin', 'main'], stdout: 'abc refs/heads/main\n',
  };
  const push: CommandResponse = {
    command: 'git', args: ['push', '--set-upstream', 'origin', sourceBranch],
  };
  const create: CommandResponse = {
    command: 'gh', args: ['pr', 'create', '--base', 'main', '--head', sourceBranch, '--fill'],
  };

  function setResponses(responses: CommandResponse[]) {
    writeFileSync(path.join(repoPath, 'responses.json'), JSON.stringify(responses));
  }

  function options() {
    return { repoPath, sourceBranch, targetBranch: 'main', remoteName: 'origin' };
  }

  beforeEach(() => {
    repoPath = mkdtempSync(path.join(os.tmpdir(), 'dmux-pr-'));
    const binPath = path.join(repoPath, 'bin');
    mkdirSync(binPath);
    for (const command of ['git', 'gh']) {
      writeFileSync(path.join(binPath, command), commandFixture, { mode: 0o755 });
    }
    vi.stubEnv('PATH', `${binPath}${path.delimiter}${process.env.PATH || ''}`);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(repoPath, { recursive: true, force: true });
  });

  it('keeps the event loop responsive during a push and preserves title/body arguments', async () => {
    const title = 'fix: keep $variables and `backticks` literal';
    const body = 'First line\n\nQuotes: "text"; $(literal text)';
    setResponses([
      version,
      { ...view, status: 1 },
      remote,
      { ...push, waitForHeartbeat: true },
      { ...create, args: [...create.args.slice(0, -1), '--title', title, '--body', body] },
      { ...view, stdout: `${url}\n` },
    ]);
    const timer = setInterval(() => {
      if (existsSync(path.join(repoPath, 'command-pending'))) {
        writeFileSync(path.join(repoPath, 'heartbeat'), '');
      }
    }, 5);

    try {
      const result = await createGitHubPullRequest({ ...options(), title, body });
      expect(result).toEqual({ url, created: true, remoteName: 'origin' });
      expect(JSON.parse(readFileSync(path.join(repoPath, 'responsive.json'), 'utf8'))).toBe(true);
      expect(JSON.parse(readFileSync(path.join(repoPath, 'responses.json'), 'utf8'))).toEqual([]);
    } finally {
      clearInterval(timer);
    }
  });

  it('returns an existing PR without pushing or creating another', async () => {
    setResponses([version, { ...view, stdout: url }]);
    await expect(createGitHubPullRequest(options())).resolves.toEqual({ url, created: false, remoteName: 'origin' });
  });

  it('rejects a missing target branch before pushing', async () => {
    setResponses([version, { ...view, status: 1 }, { ...remote, stdout: '' }]);
    await expect(createGitHubPullRequest(options())).rejects.toThrow('Remote branch origin/main was not found');
  });

  it.each(['stderr', 'stdout'] as const)('reports push errors from %s without creating a PR', async (stream) => {
    setResponses([version, { ...view, status: 1 }, remote, { ...push, status: 1, [stream]: 'Push rejected' }]);
    await expect(createGitHubPullRequest(options())).rejects.toThrow('Push rejected');
  });

  it('returns a PR created concurrently when creation fails', async () => {
    setResponses([version, { ...view, status: 1 }, remote, push, { ...create, status: 1 }, { ...view, stdout: url }]);
    await expect(createGitHubPullRequest(options())).resolves.toEqual({ url, created: false, remoteName: 'origin' });
  });

  it('preserves the creation error when no PR can be found afterward', async () => {
    setResponses([version, { ...view, status: 1 }, remote, push, { ...create, status: 1, stderr: 'Permission denied' }, { ...view, status: 1 }]);
    await expect(createGitHubPullRequest(options())).rejects.toThrow('Permission denied');
  });

  it('reports when creation succeeds but the URL cannot be determined', async () => {
    setResponses([version, { ...view, status: 1 }, remote, push, create, { ...view, status: 1 }]);
    await expect(createGitHubPullRequest(options())).rejects.toThrow('resulting URL could not be determined');
  });

  it('awaits automatic remote selection when none is supplied', async () => {
    setResponses([
      { command: 'git', args: ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], stdout: `fork/${sourceBranch}` },
      version,
      { ...view, stdout: url },
    ]);
    await expect(createGitHubPullRequest({ ...options(), remoteName: undefined })).resolves.toEqual({ url, created: false, remoteName: 'fork' });
  });

  it.each([
    { configured: 'fork', remotes: '', expected: 'fork' },
    { configured: '', remotes: 'upstream\norigin\n', expected: 'origin' },
    { configured: '', remotes: 'upstream\n', expected: 'upstream' },
  ])('selects $expected from branch configuration or remotes', async ({ configured, remotes, expected }) => {
    setResponses([
      { command: 'git', args: ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], status: 1 },
      { command: 'git', args: ['branch', '--show-current'], stdout: sourceBranch },
      { command: 'git', args: ['config', `branch.${sourceBranch}.remote`], stdout: configured, status: configured ? 0 : 1 },
      ...configured ? [] : [{ command: 'git', args: ['remote'], stdout: remotes }],
    ]);
    await expect(getPreferredPushRemote(repoPath)).resolves.toBe(expected);
  });

  it('reports when no remote is configured', async () => {
    setResponses([
      { command: 'git', args: ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], status: 1 },
      { command: 'git', args: ['branch', '--show-current'], stdout: '' },
      { command: 'git', args: ['remote'], stdout: '' },
    ]);
    await expect(getPreferredPushRemote(repoPath)).rejects.toThrow('No git remote is configured');
  });
});
