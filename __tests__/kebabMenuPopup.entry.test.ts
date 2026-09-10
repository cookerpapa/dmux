import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const mocks = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock('ink', async (importOriginal) => ({
  ...await importOriginal<typeof import('ink')>(),
  render: mocks.render,
}));

const originalArgv = process.argv;
const directories: string[] = [];

afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
  mocks.render.mockReset();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('kebab menu popup entry point', () => {
  it('loads pane name and actions from the supplied data file', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dmux-kebab-entry-'));
    directories.push(directory);
    const dataFile = path.join(directory, 'menu data.json');
    const resultFile = path.join(directory, 'result.json');
    const data = {
      paneName: '菜单 "quoted" \\ name',
      actions: [{ id: 'close', label: 'Close', description: 'large menu '.repeat(400), shortcut: 'x' }],
    };
    fs.writeFileSync(dataFile, JSON.stringify(data));
    process.argv = [process.execPath, fileURLToPath(new URL('../src/components/popups/kebabMenuPopup.tsx', import.meta.url)), resultFile, dataFile];
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('unexpected exit'); });
    vi.resetModules();

    await import('../src/components/popups/kebabMenuPopup.js');

    expect(mocks.render).toHaveBeenCalledOnce();
    expect(mocks.render.mock.calls[0][0].props).toEqual(expect.objectContaining({ resultFile, ...data }));
  });

  it.each(['missing', 'invalid'])('reports an error for a %s data file', async (kind) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dmux-kebab-entry-'));
    directories.push(directory);
    const dataFile = path.join(directory, 'data.json');
    if (kind === 'invalid') fs.writeFileSync(dataFile, '{');
    process.argv = [process.execPath, fileURLToPath(new URL('../src/components/popups/kebabMenuPopup.tsx', import.meta.url)), path.join(directory, 'result.json'), dataFile];
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('popup exit'); });
    vi.resetModules();

    await expect(import('../src/components/popups/kebabMenuPopup.js')).rejects.toThrow('popup exit');

    expect(error).toHaveBeenCalledWith('Error: Failed to read or parse data file');
    expect(exit).toHaveBeenCalledWith(1);
    expect(mocks.render).not.toHaveBeenCalled();
  });
});
