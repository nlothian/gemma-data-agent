import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import useLLMConfig from '../hooks/useLLMConfig';
import useLocalGemmaSwitcher from '../hooks/useLocalGemmaSwitcher';
import {
  formatGB,
  LOCAL_GEMMA_MODELS,
} from '../lib/localLlm/models';
import {
  getCustomModelsSnapshot,
  registerCustomModel,
  resolveActiveLocalModel,
  subscribeCustomModels,
  type CustomLocalModel,
} from '../lib/localLlm/customModels';
import {
  isFsAccessFilePickerSupported,
  persistPickedHandle,
} from '../lib/localLlm/customModelStore';
import { detectWebGpu, type WebGpuStatus } from '../lib/localLlm/webgpu';
import { isLocalGemmaEndpoint, LOCAL_GEMMA_ENDPOINT } from '../types/llm';
import { ChevronDownIcon, ChevronRightIcon } from './Icons';

const EMPTY_CUSTOM_MODELS: readonly CustomLocalModel[] = [];

export interface ModelSelectorProps {
  onModelMenuOpenChange?: (setter: (open: boolean) => void) => void;
  onRequestModelReady?: (fn: (id: string) => void) => void;
}

export default function ModelSelector({
  onModelMenuOpenChange,
  onRequestModelReady,
}: ModelSelectorProps) {
  const { config, setActiveEndpoint, setModel, setThinkingEnabled } = useLLMConfig();
  const modelSwitcher = useLocalGemmaSwitcher({ loadOnApply: true });

  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [gpuStatus, setGpuStatus] = useState<WebGpuStatus | null>(null);
  const modelMenuRef = useRef<HTMLDivElement | null>(null);

  // Registry-driven view of registered custom models so a model restored
  // elsewhere (the restore banner) or re-picked appears here too. Replaces
  // the old per-instance local state that never reflected those.
  const customModels = useSyncExternalStore(
    subscribeCustomModels,
    getCustomModelsSnapshot,
    () => EMPTY_CUSTOM_MODELS,
  );
  const fsAccessSupported = isFsAccessFilePickerSupported();

  useEffect(() => {
    if (!modelMenuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!modelMenuRef.current?.contains(e.target as Node)) {
        setModelMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setModelMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [modelMenuOpen]);

  useEffect(() => {
    let cancelled = false;
    detectWebGpu().then((s) => {
      if (!cancelled) setGpuStatus(s);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    onModelMenuOpenChange?.(setModelMenuOpen);
  }, [onModelMenuOpenChange]);

  useEffect(() => {
    onRequestModelReady?.((id) =>
      modelSwitcher.request(
        id as Parameters<typeof modelSwitcher.request>[0],
      ),
    );
  }, [onRequestModelReady, modelSwitcher.request]);

  const commitCustom = useCallback(
    (id: string): void => {
      setActiveEndpoint(LOCAL_GEMMA_ENDPOINT);
      setModel(LOCAL_GEMMA_ENDPOINT, id);
      void (async () => {
        try {
          const { ensureLoaded } = await import('../lib/localLlm/llmService');
          await ensureLoaded(id);
        } catch (err) {
          console.error('Failed to load custom model:', err);
        }
      })();
    },
    [setActiveEndpoint, setModel],
  );

  // Fallback path: plain <input type="file"> yields a transient File only,
  // so this registration is session-only (no reload persistence). Used when
  // window.showOpenFilePicker is unavailable.
  const onFileChosen = useCallback(
    (file: File): void => {
      const m = registerCustomModel(file);
      commitCustom(m.id);
      setAdvancedOpen(false);
      setModelMenuOpen(false);
    },
    [commitCustom],
  );

  // Preferred path: showOpenFilePicker returns a FileSystemFileHandle which
  // customModelStore persists to IndexedDB so the model survives a reload.
  // Both paths funnel through registerCustomModel (inside persistPickedHandle)
  // so the two pickers cannot diverge.
  const onPickViaFsAccess = useCallback(async (): Promise<void> => {
    try {
      const [handle] = await window.showOpenFilePicker({
        multiple: false,
        types: [
          {
            description: 'Gemma .task model',
            accept: { 'application/octet-stream': ['.task'] },
          },
        ],
      });
      if (!handle) return;
      const m = await persistPickedHandle(handle);
      commitCustom(m.id);
      setAdvancedOpen(false);
      setModelMenuOpen(false);
    } catch (err) {
      // AbortError = user dismissed the picker — silent.
      if ((err as { name?: string } | null)?.name === 'AbortError') return;
      console.error('Custom model pick failed:', err);
    }
  }, [commitCustom]);

  const ep = config.activeEndpoint;
  const rawModel = ep ? config.models[ep] : '';
  const isLocal = ep ? isLocalGemmaEndpoint(ep) : false;
  const resolvedActive = isLocal ? resolveActiveLocalModel(rawModel) : undefined;
  const labelText = isLocal
    ? resolvedActive?.label ?? 'Choose model'
    : rawModel || 'Choose model';
  const isEmpty = !ep || !rawModel || (isLocal && !resolvedActive);
  const webGpuSupported = gpuStatus?.supported === true;
  const webGpuReason = gpuStatus?.reason;
  const pendingConfirm =
    modelSwitcher.state.phase === 'confirm' ? modelSwitcher.state.model : null;

  return (
    <>
      <div className="chat-model-split" ref={modelMenuRef}>
        <span
          className={
            'chat-model chat-model-label' + (isEmpty ? ' chat-model-empty' : '')
          }
        >
          {labelText}
        </span>
        <button
          type="button"
          className="chat-iconbtn chat-model-menu-btn"
          data-tour-id="chat.modelDropdown"
          onClick={() => setModelMenuOpen((v) => !v)}
          title={
            webGpuSupported
              ? 'Choose local model'
              : webGpuReason ?? 'WebGPU is unavailable.'
          }
          aria-label="Choose local model"
          aria-haspopup="menu"
          aria-expanded={modelMenuOpen}
          disabled={!webGpuSupported}
        >
          <ChevronDownIcon size={12} />
        </button>
        {modelMenuOpen && (
          <div
            className="chat-model-popover"
            role="menu"
            data-tour-id="chat.modelPopover"
          >
            {LOCAL_GEMMA_MODELS.map((m) => {
              const isActive =
                ep === LOCAL_GEMMA_ENDPOINT && rawModel === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  role="menuitem"
                  className={
                    'chat-model-option' +
                    (isActive ? ' chat-model-option--active' : '')
                  }
                  onClick={() => {
                    modelSwitcher.request(m.id);
                    setModelMenuOpen(false);
                  }}
                >
                  <span className="chat-model-option-main">
                    <img
                      src="/gemma-color.svg"
                      alt=""
                      aria-hidden="true"
                      className="chat-model-prefix"
                    />
                    <span className="chat-model-option-label">{m.label}</span>
                  </span>
                  <span className="chat-model-size">
                    {formatGB(m.approxBytes)}
                  </span>
                </button>
              );
            })}

            {customModels.map((cm) => (
              <button
                key={cm.id}
                type="button"
                role="menuitem"
                className={
                  'chat-model-option' +
                  (ep === LOCAL_GEMMA_ENDPOINT && rawModel === cm.id
                    ? ' chat-model-option--active'
                    : '')
                }
                onClick={() => {
                  commitCustom(cm.id);
                  setModelMenuOpen(false);
                }}
              >
                <span className="chat-model-option-main">
                  <span className="chat-model-option-label">{cm.label}</span>
                </span>
              </button>
            ))}

            <div className="chat-model-divider" role="separator" />

            <button
              type="button"
              className="chat-model-advanced-toggle"
              aria-expanded={advancedOpen}
              onClick={() => setAdvancedOpen((v) => !v)}
            >
              <ChevronRightIcon
                size={14}
                style={{
                  transform: advancedOpen ? 'rotate(90deg)' : 'none',
                  transition: 'transform 120ms',
                }}
              />
              <span className="chat-model-option-label">Advanced</span>
            </button>

            {advancedOpen && (
              <div className="chat-model-advanced-panel">
                {fsAccessSupported ? (
                  <button
                    type="button"
                    className="chat-model-fileinput"
                    onClick={onPickViaFsAccess}
                  >
                    <span>Choose .task file…</span>
                  </button>
                ) : (
                  <label className="chat-model-fileinput">
                    <input
                      type="file"
                      accept=".task"
                      onChange={(e) => {
                        const f = e.currentTarget.files?.[0];
                        e.currentTarget.value = '';
                        if (f) onFileChosen(f);
                      }}
                    />
                    <span>Choose .task file…</span>
                  </label>
                )}
              </div>
            )}
          </div>
        )}
        {pendingConfirm && (
          <div className="chat-model-confirm" role="alert">
            <p className="chat-model-confirm-text">
              {pendingConfirm.label} is about{' '}
              {formatGB(pendingConfirm.approxBytes)}. It will download and cache
              now.
            </p>
            <div className="chat-model-confirm-actions">
              <button
                type="button"
                className="chat-model-apply"
                onClick={modelSwitcher.apply}
              >
                Apply
              </button>
              <button
                type="button"
                className="chat-model-cancel"
                onClick={modelSwitcher.cancel}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
      {ep && config.models[ep] && isLocalGemmaEndpoint(ep) && (
        <label className="chat-thinking-toggle">
          <input
            type="checkbox"
            checked={config.thinkingEnabled?.[LOCAL_GEMMA_ENDPOINT] ?? false}
            onChange={(e) =>
              setThinkingEnabled(LOCAL_GEMMA_ENDPOINT, e.target.checked)
            }
            aria-label="Enable Gemma thinking mode"
          />
          Thinking
        </label>
      )}
    </>
  );
}
