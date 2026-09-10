import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DMUX_BOOTSTRAP_PANE_TITLE_PREFIX } from '../src/utils/paneBootstrapConfig.js';

const fsMock = vi.hoisted(() => ({
  readFileSync: vi.fn(() => JSON.stringify({ controlPaneId: '%0' })),
}));

const tmuxServiceMock = vi.hoisted(() => ({
  getCurrentPaneIdSync: vi.fn(() => '%0'),
  getCurrentSessionNameSync: vi.fn(() => 'dmux-test'),
  paneExists: vi.fn(async () => true),
  setSessionOptionSync: vi.fn(),
  setPaneTitle: vi.fn(async (_paneId: string, _title: string) => {}),
  refreshClient: vi.fn(async () => {}),
  sendShellCommand: vi.fn(async () => {}),
  sendTmuxKeys: vi.fn(async () => {}),
  selectPane: vi.fn(async () => {}),
}));

const splitPaneMock = vi.hoisted(() => vi.fn(() => '%1'));
const execSyncMock = vi.hoisted(() => vi.fn());
const setupSidebarLayoutMock = vi.hoisted(() => vi.fn(() => '%1'));
const recalculateAndApplyLayoutMock = vi.hoisted(() => vi.fn(async () => {}));
const getInstalledAgentsMock = vi.hoisted(() => vi.fn(async () => ['claude', 'codex']));
const filterEnabledAgentsMock = vi.hoisted(() => vi.fn((agents: string[]) => agents));
const destroyWelcomePaneCoordinatedMock = vi.hoisted(() => vi.fn());
const readWorktreeMetadataMock = vi.hoisted(() => vi.fn(() => ({
  agent: 'codex',
  permissionMode: 'bypassPermissions',
  branchName: 'feature/reopen-me',
  mergeTargetChain: [{ branchName: 'main', worktreePath: '/repo' }],
})));

vi.mock('child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('child_process')>(),
  execSync: execSyncMock,
}));

vi.mock('fs', () => ({
  default: fsMock,
  ...fsMock,
}));

vi.mock('../src/services/TmuxService.js', () => ({
  TmuxService: {
    getInstance: vi.fn(() => tmuxServiceMock),
  },
}));

vi.mock('../src/utils/tmux.js', () => ({
  ensurePaneBorderStatusForCurrentSession: vi.fn(() => {
    tmuxServiceMock.setSessionOptionSync(
      tmuxServiceMock.getCurrentSessionNameSync(),
      'pane-border-status',
      'top'
    );
  }),
  setupSidebarLayout: setupSidebarLayoutMock,
  splitPane: splitPaneMock,
  getTerminalDimensions: vi.fn(() => ({ width: 160, height: 40 })),
}));

vi.mock('../src/utils/layoutManager.js', () => ({
  SIDEBAR_WIDTH: 40,
  recalculateAndApplyLayout: recalculateAndApplyLayoutMock,
}));

vi.mock('../src/utils/settingsManager.js', () => ({
  SettingsManager: vi.fn(() => ({
    getSettings: vi.fn(() => ({
      permissionMode: 'plan',
      enabledAgents: ['claude', 'codex'],
      enableAutopilotByDefault: false,
    })),
  })),
}));

vi.mock('../src/utils/agentDetection.js', () => ({
  getInstalledAgents: getInstalledAgentsMock,
  filterEnabledAgents: filterEnabledAgentsMock,
}));

vi.mock('../src/utils/worktreeMetadata.js', () => ({
  readWorktreeMetadata: readWorktreeMetadataMock,
}));

vi.mock('../src/utils/paneTitle.js', () => ({
  buildWorktreePaneTitle: vi.fn((slug: string) => slug),
}));

vi.mock('../src/utils/git.js', () => ({
  getCurrentBranch: vi.fn(() => 'feature/reopen-me'),
}));

vi.mock('../src/utils/geminiTrust.js', () => ({
  ensureGeminiFolderTrusted: vi.fn(),
}));

vi.mock('../src/utils/atomicWrite.js', () => ({
  atomicWriteJsonSync: vi.fn(),
}));

vi.mock('../src/utils/welcomePaneManager.js', () => ({
  destroyWelcomePaneCoordinated: destroyWelcomePaneCoordinatedMock,
}));

describe('reopenWorktree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tmuxServiceMock.setPaneTitle.mockReset().mockResolvedValue(undefined);
    execSyncMock.mockReset();
    fsMock.readFileSync.mockReturnValue(JSON.stringify({ controlPaneId: '%0' }));
    readWorktreeMetadataMock.mockReturnValue({
      agent: 'codex',
      permissionMode: 'bypassPermissions',
      branchName: 'feature/reopen-me',
      mergeTargetChain: [{ branchName: 'main', worktreePath: '/repo' }],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([true, false])('keeps a reopened worktree out of shell detection until saved (first pane: %s)', async (firstPane) => {
    const { reopenWorktree } = await import('../src/utils/reopenWorktree.js');
    const { getUntrackedPanes } = await import('../src/utils/shellPaneDetection.js');
    vi.useFakeTimers();

    let title = 'zsh';
    tmuxServiceMock.setPaneTitle.mockImplementation(async (_paneId, nextTitle) => {
      title = nextTitle;
    });
    execSyncMock.mockImplementation(() => `%1::${title}::zsh\n%2::manual-shell::zsh`);
    const manualShell = [{ paneId: '%2', title: 'manual-shell', command: 'zsh' }];
    const projectRoot = firstPane ? '/repo' : '/other-repo';

    const reopening = reopenWorktree({
      slug: 'reopen-me',
      worktreePath: `${projectRoot}/.dmux/worktrees/reopen-me`,
      projectRoot,
      existingPanes: firstPane ? [] : [{ id: 'dmux-0', slug: 'existing', prompt: '', paneId: '%9' }],
      sessionProjectRoot: '/repo',
      sessionConfigPath: '/repo/.dmux/dmux.config.json',
    });

    // Poll while the first startup delay is still pending, before config can
    // contain the reopened pane. A genuine user-created shell is still found.
    await vi.advanceTimersByTimeAsync(0);
    const duringStartup = await getUntrackedPanes('dmux-test', [], '%0');
    await vi.runAllTimersAsync();
    const { pane } = await reopening;
    expect(duringStartup).toEqual(manualShell);

    // The caller saves the returned pane later. Do not drop the guard at the
    // end of reopenWorktree and reintroduce the same race during that save.
    expect(title).toBe(`${DMUX_BOOTSTRAP_PANE_TITLE_PREFIX}reopen-me`);
    expect(await getUntrackedPanes('dmux-test', [], '%0')).toEqual(manualShell);
    expect(pane.worktreePath).toBe(`${projectRoot}/.dmux/worktrees/reopen-me`);
    expect(pane.mergeTargetChain).toEqual([{ branchName: 'main', worktreePath: '/repo' }]);
    expect(pane.type).not.toBe('shell');
  });

  it('uses stored agent metadata and permission mode for resume', async () => {
    const { reopenWorktree } = await import('../src/utils/reopenWorktree.js');

    const result = await reopenWorktree({
      slug: 'reopen-me',
      worktreePath: '/repo/.dmux/worktrees/reopen-me',
      projectRoot: '/repo',
      existingPanes: [],
      sessionProjectRoot: '/repo',
      sessionConfigPath: '/repo/.dmux/dmux.config.json',
    });

    expect(tmuxServiceMock.sendShellCommand).toHaveBeenCalledWith(
      '%1',
      expect.stringMatching(
        /^export DMUX_PANE_ID='dmux-\d+'; export DMUX_TMUX_PANE_ID='%1'; codex --enable hooks resume --last --dangerously-bypass-approvals-and-sandbox$/
      )
    );
    expect(tmuxServiceMock.setSessionOptionSync).toHaveBeenCalledWith(
      'dmux-test',
      'pane-border-status',
      'top'
    );
    expect(result.pane.agent).toBe('codex');
    expect(result.pane.permissionMode).toBe('bypassPermissions');
  });

  it('destroys the welcome pane even when only shell panes already exist', async () => {
    const { reopenWorktree } = await import('../src/utils/reopenWorktree.js');

    await reopenWorktree({
      slug: 'reopen-me',
      worktreePath: '/repo/.dmux/worktrees/reopen-me',
      projectRoot: '/repo',
      existingPanes: [
        {
          id: 'dmux-1',
          slug: 'shell-1',
          prompt: '',
          paneId: '%9',
          type: 'shell',
          shellType: 'zsh',
        },
      ],
      sessionProjectRoot: '/repo',
      sessionConfigPath: '/repo/.dmux/dmux.config.json',
    });

    expect(destroyWelcomePaneCoordinatedMock).toHaveBeenCalledWith('/repo');
  });
});
