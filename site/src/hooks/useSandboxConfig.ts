import { useCallback, useSyncExternalStore } from 'react';
import * as store from '../lib/sandboxStore';
import * as files from '../lib/sandboxFiles';
import type {
  SandboxFileEntry,
  SandboxStatus,
} from '../lib/sandboxStore';
import type { LoadedSandboxFile } from '../lib/sandboxFiles';

export interface UseSandboxConfigResult {
  status: SandboxStatus;
  directoryName?: string;
  files: SandboxFileEntry[];
  isUnsupported: boolean;
  chooseDirectory: () => Promise<void>;
  reAuthorise: () => Promise<void>;
  refreshFiles: () => Promise<void>;
  clearDirectory: () => Promise<void>;
}

export default function useSandboxConfig(): UseSandboxConfigResult {
  store.hydrateOnce();
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  );

  const chooseDirectory = useCallback(async () => {
    try {
      await store.chooseDirectory();
    } catch (err) {
      // AbortError is fired when the user cancels the picker — silent.
      if ((err as { name?: string } | null)?.name === 'AbortError') return;
      console.error('chooseDirectory failed:', err);
    }
  }, []);

  const reAuthorise = useCallback(async () => {
    try {
      await store.reAuthorise();
    } catch (err) {
      console.error('reAuthorise failed:', err);
    }
  }, []);

  const refreshFiles = useCallback(async () => {
    try {
      await store.refreshFiles();
    } catch (err) {
      console.error('refreshFiles failed:', err);
    }
  }, []);

  const clearDirectory = useCallback(async () => {
    try {
      await store.clearDirectory();
    } catch (err) {
      console.error('clearDirectory failed:', err);
    }
  }, []);

  return {
    status: state.status,
    directoryName: state.directoryName,
    files: state.files,
    isUnsupported: state.status === 'unsupported',
    chooseDirectory,
    reAuthorise,
    refreshFiles,
    clearDirectory,
  };
}

const EMPTY_LOADED_SANDBOX_FILES: readonly LoadedSandboxFile[] = [];

export function useLoadedSandboxFiles(): readonly LoadedSandboxFile[] {
  return useSyncExternalStore(
    files.subscribe,
    files.getLoadedSandboxFiles,
    () => EMPTY_LOADED_SANDBOX_FILES,
  );
}
