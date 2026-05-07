import { useSyncExternalStore } from 'react';
import * as uiStore from '../lib/sourcecode/uiStore';
import SourcecodeOverlay from './SourcecodeOverlay';

export default function SourcecodeOverlayHost(): JSX.Element | null {
  const open = useSyncExternalStore(
    uiStore.subscribe,
    uiStore.getSnapshot,
    uiStore.getServerSnapshot,
  );
  return <SourcecodeOverlay open={open} onClose={uiStore.closeSourcecode} />;
}
