/**
 * Single shared opener for "show this source range to the user."
 *
 * Both the explainer's `HighlightSourcecode` tool and the `@sourcecode:`
 * markdown-link click handler call this. It collapses the execution pane to
 * the side rail (so the explainer fills the height), drives the open-file
 * store to file-viewer mode at the requested range, and shows the overlay.
 */

import { setExecCollapsed } from '../paneCollapseStore';
import { openSourcecode } from './uiStore';
import { setOpenFile } from './openFileStore';

export interface ShowSourcecodeRangeArgs {
  path: string;
  /** 1-based start line. */
  startLine: number;
  /** 1-based end line; defaults to `startLine` (single-line highlight). */
  endLine?: number;
}

export function showSourcecodeRange(args: ShowSourcecodeRangeArgs): void {
  const startLine = Math.max(1, Math.floor(args.startLine));
  const endLine = Math.max(startLine, Math.floor(args.endLine ?? startLine));
  setExecCollapsed(true);
  setOpenFile({ kind: 'range', path: args.path, startLine, endLine });
  openSourcecode();
}
