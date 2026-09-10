import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';

const popupMocks = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock('../src/utils/popup.js', () => ({
  launchNodePopupNonBlocking: popupMocks.launch,
  POPUP_POSITIONING: { standard: () => ({}) },
}));

import { PopupManager, type PopupManagerConfig } from '../src/services/PopupManager.js';
import type { DmuxPane } from '../src/types.js';

function createPopupManager(): PopupManager {
  const config: PopupManagerConfig = {
    sidebarWidth: 40,
    projectRoot: '/tmp/project',
    popupsSupported: true,
    isDevMode: false,
    terminalWidth: 120,
    terminalHeight: 40,
    availableAgents: ['claude', 'codex'],
    settingsManager: {
      getSettings: () => ({}),
      getGlobalSettings: () => ({}),
      getProjectSettings: () => ({}),
    },
    projectSettings: {},
    trackProjectActivity: async (work) => await work(),
  };

  return new PopupManager(config, () => {}, () => {});
}

function createPane(id: string): DmuxPane {
  return {
    id,
    slug: `pane-${id}`,
    displayName: `Pane ${id}`,
    prompt: `prompt-${id}`,
    paneId: `%${id}`,
    projectRoot: '/tmp/project',
    worktreePath: `/tmp/project/.dmux/worktrees/pane-${id}`,
  };
}

describe('PopupManager launchKebabMenuPopup', () => {
  afterEach(() => vi.restoreAllMocks());

  it('anchors the popup to the target pane when requested', async () => {
    const manager = createPopupManager() as any;
    const pane = createPane('1');

    manager.checkPopupSupport = vi.fn(() => true);
    manager.launchPopup = vi.fn().mockResolvedValue({
      success: true,
      data: 'view',
    });

    await manager.launchKebabMenuPopup(pane, [pane], { anchorToPane: true });

    const [, , , popupData] = manager.launchPopup.mock.calls[0];
    const { actions } = popupData;

    expect(manager.launchPopup).toHaveBeenCalledWith(
      'kebabMenuPopup.js',
      [],
      expect.objectContaining({
        width: 60,
        height: Math.min(26, actions.length + 6),
        title: 'Menu: Pane 1',
        positioning: 'pane',
        targetPaneId: pane.paneId,
      }),
      { paneName: 'Pane 1', actions },
      '/tmp/project'
    );
  });

  it.each(['selected', 'cancelled', 'launch failed'])('passes menu data through a file and cleans it up when %s', async (outcome) => {
    const manager = createPopupManager();
    const pane = createPane('1');
    pane.displayName = '菜单 "quoted" \\ name';
    let dataFile = '';
    popupMocks.launch.mockImplementation((_script, args) => {
      expect(args).toHaveLength(1);
      dataFile = args[0];
      const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      expect(data.paneName).toBe(pane.displayName);
      expect(data.actions.length).toBeGreaterThan(1);
      expect(data.actions).toContainEqual(expect.objectContaining({ id: 'close' }));
      expect(JSON.stringify(args).length).toBeLessThan(JSON.stringify(data).length);
      if (outcome === 'launch failed') throw new Error('popup failed');
      return {
        readyPromise: Promise.resolve(),
        resultPromise: Promise.resolve(outcome === 'selected'
          ? { success: true, data: 'close' }
          : { success: false, cancelled: true }),
      };
    });

    const result = await manager.launchKebabMenuPopup(pane, [pane]);

    expect(dataFile).not.toBe('');
    expect(fs.existsSync(dataFile)).toBe(false);
    expect(result).toBe(outcome === 'selected' ? 'close' : null);
  });
});
