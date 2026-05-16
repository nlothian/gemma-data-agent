// Ambient declarations for the File System Access API parts not yet in
// lib.dom.d.ts: window.showDirectoryPicker and per-handle permission methods.

interface FileSystemHandlePermissionDescriptor {
  mode?: 'read' | 'readwrite';
}

interface FileSystemHandle {
  queryPermission(
    descriptor?: FileSystemHandlePermissionDescriptor,
  ): Promise<'granted' | 'denied' | 'prompt'>;
  requestPermission(
    descriptor?: FileSystemHandlePermissionDescriptor,
  ): Promise<'granted' | 'denied' | 'prompt'>;
}

interface FileSystemDirectoryHandle {
  values(): AsyncIterableIterator<FileSystemFileHandle | FileSystemDirectoryHandle>;
}

interface ShowDirectoryPickerOptions {
  id?: string;
  mode?: 'read' | 'readwrite';
  startIn?: FileSystemHandle | string;
}

interface ShowOpenFilePickerOptions {
  id?: string;
  multiple?: boolean;
  excludeAcceptAllOption?: boolean;
  types?: { description?: string; accept: Record<string, string[]> }[];
  startIn?: FileSystemHandle | string;
}

interface Window {
  showDirectoryPicker(
    options?: ShowDirectoryPickerOptions,
  ): Promise<FileSystemDirectoryHandle>;
  showOpenFilePicker(
    options?: ShowOpenFilePickerOptions,
  ): Promise<FileSystemFileHandle[]>;
}
