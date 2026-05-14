import { test, expect } from '@playwright/test';

// Covers the "New chat" button wiping OPFS /scratchpad. Seeds the directory
// with a file, a nested directory, and a nested file, then drives onNewChat
// through the tour chat bridge (same function the button onClick invokes —
// sidesteps the button's hasMessages disabled gate).

async function seedScratchpad(page: import('@playwright/test').Page) {
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    // Start from a known-clean state so a prior run doesn't taint the seed.
    try {
      await root.removeEntry('scratchpad', { recursive: true });
    } catch {
      // First run: nothing to remove.
    }
    const dir = await root.getDirectoryHandle('scratchpad', { create: true });

    const top = await dir.getFileHandle('top.txt', { create: true });
    const tw = await top.createWritable();
    await tw.write('hello');
    await tw.close();

    const sub = await dir.getDirectoryHandle('sub', { create: true });
    const nested = await sub.getFileHandle('nested.md', { create: true });
    const nw = await nested.createWritable();
    await nw.write('# nested');
    await nw.close();
  });
}

async function listScratchpadEntries(
  page: import('@playwright/test').Page,
): Promise<string[] | null> {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    let dir: FileSystemDirectoryHandle;
    try {
      dir = await root.getDirectoryHandle('scratchpad', { create: false });
    } catch {
      return null;
    }
    const names: string[] = [];
    for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) {
      names.push(name);
    }
    names.sort();
    return names;
  });
}

test.describe('New chat clears /scratchpad', () => {
  test('removes every entry under /scratchpad while keeping the directory', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByText('Choose model')).toBeVisible();

    await seedScratchpad(page);
    expect(await listScratchpadEntries(page)).toEqual(['sub', 'top.txt']);

    // ChatSidebar registers the chat bridge on mount; newChat() is exactly
    // what the header button's onClick calls.
    await page.evaluate(async () => {
      const bridge = await import('/src/lib/tour/bridge.ts');
      bridge.getChatBridge().newChat();
    });

    await expect
      .poll(() => listScratchpadEntries(page), { timeout: 5000 })
      .toEqual([]);
  });
});
