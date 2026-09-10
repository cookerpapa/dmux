#!/usr/bin/env node

/**
 * Standalone popup for kebab menu
 * Runs in a tmux popup modal and writes result to a file
 */

import React, { useState, useEffect } from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';
import type { PaneMenuAction } from '../../actions/types.js';
import { PopupContainer, PopupWrapper, writeSuccessAndExit } from './shared/index.js';
import { POPUP_CONFIG } from './config.js';
import { pathToFileURL } from 'url';
import fs from 'fs';
import {
  createMouseFilteredStdin,
  MOUSE_REPORTING_ENABLE,
  MOUSE_REPORTING_DISABLE,
  MOUSE_LEFT_BUTTON,
  MOUSE_WHEEL_UP_BUTTON,
  MOUSE_WHEEL_DOWN_BUTTON,
  type SidebarMouseEvent,
  type SidebarMouseEventSource,
} from '../../utils/sidebarMouse.js';

interface KebabMenuPopupProps {
  resultFile: string;
  paneName: string;
  actions: PaneMenuAction[];
  mouseEvents?: SidebarMouseEventSource;
}

/**
 * Map a click row (1-based, popup-interior coordinates) to a menu action
 * index. The action list starts right below PopupContainer's top padding.
 */
export function resolveMenuClickIndex(row: number, actionCount: number): number | null {
  const index = row - POPUP_CONFIG.containerPadding.y - 1;
  return index >= 0 && index < actionCount ? index : null;
}

export const KebabMenuPopupApp: React.FC<KebabMenuPopupProps> = ({ resultFile, paneName, actions, mouseEvents }) => {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const { exit } = useApp();

  useEffect(() => {
    if (!mouseEvents) return;

    const handleMouse = (event: SidebarMouseEvent) => {
      if (event.type !== 'press') return;

      if (event.button === MOUSE_WHEEL_UP_BUTTON) {
        setSelectedIndex((current) => (current <= 0 ? actions.length - 1 : current - 1));
        return;
      }
      if (event.button === MOUSE_WHEEL_DOWN_BUTTON) {
        setSelectedIndex((current) => (current >= actions.length - 1 ? 0 : current + 1));
        return;
      }
      if (event.button !== MOUSE_LEFT_BUTTON) return;

      const index = resolveMenuClickIndex(event.row, actions.length);
      if (index !== null) {
        writeSuccessAndExit(resultFile, actions[index].id, exit);
      }
    };

    mouseEvents.on('mouse', handleMouse);
    return () => {
      mouseEvents.off('mouse', handleMouse);
    };
  }, [mouseEvents, actions, resultFile, exit]);

  useInput((input, key) => {
    if (key.upArrow) {
      setSelectedIndex(selectedIndex <= 0 ? actions.length - 1 : selectedIndex - 1);
    } else if (key.downArrow) {
      setSelectedIndex(selectedIndex >= actions.length - 1 ? 0 : selectedIndex + 1);
    } else if (key.return) {
      // User selected an action
      const selectedAction = actions[selectedIndex];
      writeSuccessAndExit(resultFile, selectedAction.id, exit);
    } else {
      const shortcutAction = actions.find((action) => action.shortcut === input);
      if (shortcutAction) {
        writeSuccessAndExit(resultFile, shortcutAction.id, exit);
      }
    }
  });

  return (
    <PopupWrapper resultFile={resultFile}>
      <PopupContainer footer="↑↓ navigate • Enter/click/hotkey selects • ESC cancels">
        {/* Action list */}
        {actions.map((action, index) => (
          <Box key={action.id} width="100%">
            <Box flexGrow={1}>
              <Text color={selectedIndex === index ? POPUP_CONFIG.titleColor : 'white'} bold={selectedIndex === index}>
                {selectedIndex === index ? '▶ ' : '  '}
                {action.label}
              </Text>
            </Box>
            {action.shortcut ? (
              <Text color="yellow">[{action.shortcut}]</Text>
            ) : null}
          </Box>
        ))}
      </PopupContainer>
    </PopupWrapper>
  );
};

// Entry point
function main() {
  const resultFile = process.argv[2];
  const dataFile = process.argv[3];

  if (!resultFile || !dataFile) {
    console.error('Error: Result file and data file required');
    process.exit(1);
  }

  let data: { paneName: string; actions: PaneMenuAction[] };
  try {
    data = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
  } catch (error) {
    console.error('Error: Failed to read or parse data file');
    process.exit(1);
  }

  // Clickable menu items: enable mouse reporting in the popup's pty and
  // keep the raw sequences out of Ink's stdin (same scheme as the sidebar).
  const mouseFilter = process.stdin.isTTY ? createMouseFilteredStdin(process.stdin) : null;
  if (mouseFilter) {
    process.stdout.write(MOUSE_REPORTING_ENABLE);
    process.on('exit', () => {
      process.stdout.write(MOUSE_REPORTING_DISABLE);
    });
  }

  render(
    <KebabMenuPopupApp
      resultFile={resultFile}
      paneName={data.paneName}
      actions={data.actions}
      mouseEvents={mouseFilter?.events}
    />,
    mouseFilter ? { stdin: mouseFilter.stdin } : undefined
  );
}

const entryPointHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entryPointHref) {
  main();
}
