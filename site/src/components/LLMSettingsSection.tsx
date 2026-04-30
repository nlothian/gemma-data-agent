import { useEffect, useState } from 'react';
import {
  EyeIcon,
  EyeOffIcon,
  PlusIcon,
  TrashIcon,
} from './Icons';
import ModelPickerCell from './ModelPickerCell';
import useLLMConfig from '../hooks/useLLMConfig';
import useProviderModels from '../hooks/useProviderModels';
import {
  BUILT_IN_PROVIDERS,
  LOCAL_GEMMA_ENDPOINT,
  type CustomEndpoint,
} from '../types/llm';
import {
  DEFAULT_LOCAL_GEMMA_ID,
  LOCAL_GEMMA_MODELS,
  formatGB,
  getLocalGemmaModel,
  type LocalGemmaId,
  type LocalGemmaModel,
} from '../lib/localLlm/models';
import { isModelCached } from '../lib/localLlm/opfsCache';
import { detectWebGpu, type WebGpuStatus } from '../lib/localLlm/webgpu';

const styles = {
  wrapper: {
    marginTop: '8px',
  } as const,
  sectionHeading: {
    fontFamily: 'var(--font-mono)',
    fontWeight: 500,
    fontSize: '11px',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.12em',
    color: 'var(--aqua-700)',
    margin: '0 0 8px',
  } as const,
  caption: {
    fontFamily: 'var(--font-sans)',
    fontWeight: 400,
    fontSize: '14px',
    lineHeight: 1.55,
    color: 'var(--steel)',
    margin: '0 0 16px',
  } as const,
  list: {
    display: 'flex',
    flexDirection: 'column' as const,
    border: '1px solid var(--mist)',
    borderRadius: 'var(--r-8)',
    overflow: 'hidden' as const,
    background: 'var(--white)',
  } as const,
  row: {
    display: 'flex',
    alignItems: 'flex-start' as const,
    gap: '12px',
    padding: '12px',
    borderBottom: '1px solid var(--mist)',
  } as const,
  rowLast: {
    borderBottom: 'none',
  } as const,
  radio: {
    marginTop: '10px',
    accentColor: 'var(--aqua-500)',
    cursor: 'pointer',
  } as const,
  middle: {
    flex: '1 1 0',
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '6px',
  } as const,
  builtInLabel: {
    fontFamily: 'var(--font-sans)',
    fontWeight: 500,
    fontSize: '14px',
    color: 'var(--ink)',
    padding: '6px 0 0',
  } as const,
  builtInUrl: {
    fontFamily: 'var(--font-mono)',
    fontWeight: 400,
    fontSize: '12px',
    color: 'var(--steel)',
  } as const,
  input: {
    fontFamily: 'var(--font-sans)',
    fontWeight: 400,
    fontSize: '13px',
    color: 'var(--ink)',
    height: '36px',
    padding: '0 10px',
    border: '1px solid var(--silver)',
    borderRadius: 'var(--r-8)',
    outline: 'none',
    background: 'var(--white)',
    width: '100%',
    boxSizing: 'border-box' as const,
  } as const,
  modelWrap: {
    width: '200px',
    flex: '0 0 200px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '4px',
  } as const,
  modelRowInner: {
    display: 'flex',
    alignItems: 'flex-start' as const,
    gap: '6px',
  } as const,
  splitStack: {
    flex: '1 1 auto',
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '4px',
  } as const,
  selectEl: {
    fontFamily: 'var(--font-sans)',
    fontWeight: 400,
    fontSize: '13px',
    color: 'var(--ink)',
    height: '36px',
    padding: '0 8px',
    border: '1px solid var(--silver)',
    borderRadius: 'var(--r-8)',
    outline: 'none',
    background: 'var(--white)',
    flex: '1 1 auto',
    minWidth: 0,
    boxSizing: 'border-box' as const,
    appearance: 'auto' as const,
  } as const,
  refreshButton: {
    width: '28px',
    height: '28px',
    flex: '0 0 28px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'transparent',
    border: '1px solid transparent',
    borderRadius: 'var(--r-4)',
    color: 'var(--steel)',
    cursor: 'pointer',
  } as const,
  spinnerIcon: {
    color: 'var(--steel)',
    animation: 'haw-spin 1s linear infinite',
  } as const,
  errorText: {
    fontFamily: 'var(--font-sans)',
    fontWeight: 400,
    fontSize: '11px',
    color: 'var(--danger-500)',
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    lineHeight: 1.3,
    overflow: 'hidden' as const,
    textOverflow: 'ellipsis' as const,
    whiteSpace: 'nowrap' as const,
  } as const,
  customLink: {
    fontFamily: 'var(--font-sans)',
    fontWeight: 500,
    fontSize: '11px',
    color: 'var(--aqua-600)',
    background: 'transparent',
    border: 'none',
    padding: 0,
    cursor: 'pointer',
    alignSelf: 'flex-start' as const,
    textDecoration: 'underline',
  } as const,
  keyWrap: {
    position: 'relative' as const,
    width: '200px',
    flex: '0 0 200px',
  } as const,
  keyInput: {
    paddingRight: '36px',
  } as const,
  keyToggle: {
    position: 'absolute' as const,
    right: '4px',
    top: '50%',
    transform: 'translateY(-50%)',
    width: '28px',
    height: '28px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'transparent',
    border: 'none',
    color: 'var(--steel)',
    cursor: 'pointer',
    borderRadius: 'var(--r-4)',
  } as const,
  removeButton: {
    width: '32px',
    height: '36px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'transparent',
    border: '1px solid transparent',
    borderRadius: 'var(--r-8)',
    color: 'var(--steel)',
    cursor: 'pointer',
    transition: 'color 120ms ease, border-color 120ms ease',
  } as const,
  removeSpacer: {
    width: '32px',
    flex: '0 0 32px',
  } as const,
  addButton: {
    fontFamily: 'var(--font-sans)',
    fontWeight: 500,
    fontSize: '13px',
    letterSpacing: '0.01em',
    color: 'var(--aqua-600)',
    background: 'transparent',
    border: 'none',
    padding: '12px 0 0',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    cursor: 'pointer',
    alignSelf: 'flex-start' as const,
  } as const,
  localHint: {
    fontFamily: 'var(--font-sans)',
    fontWeight: 400,
    fontSize: '12px',
    color: 'var(--steel)',
    margin: '6px 0 0',
    lineHeight: 1.4,
  } as const,
  localConfirm: {
    marginTop: '8px',
    padding: '10px 12px',
    border: '1px solid var(--aqua-200, var(--mist))',
    background: 'var(--aqua-50)',
    borderRadius: 'var(--r-8)',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '8px',
  } as const,
  localConfirmText: {
    fontFamily: 'var(--font-sans)',
    fontSize: '13px',
    color: 'var(--ink)',
    lineHeight: 1.45,
    margin: 0,
  } as const,
  localConfirmActions: {
    display: 'flex',
    gap: '8px',
  } as const,
  localApplyButton: {
    fontFamily: 'var(--font-sans)',
    fontWeight: 500,
    fontSize: '12px',
    color: 'var(--white)',
    background: 'var(--aqua-600)',
    border: '1px solid var(--aqua-600)',
    padding: '6px 12px',
    borderRadius: 'var(--r-8)',
    cursor: 'pointer',
  } as const,
  localCancelButton: {
    fontFamily: 'var(--font-sans)',
    fontWeight: 500,
    fontSize: '12px',
    color: 'var(--graphite)',
    background: 'var(--white)',
    border: '1px solid var(--silver)',
    padding: '6px 12px',
    borderRadius: 'var(--r-8)',
    cursor: 'pointer',
  } as const,
};

function onInputFocus(e: React.FocusEvent<HTMLInputElement>): void {
  e.currentTarget.style.borderColor = 'var(--aqua-500)';
  e.currentTarget.style.boxShadow = '0 0 0 3px var(--aqua-50)';
}

function resetInputStyle(el: HTMLInputElement): void {
  el.style.borderColor = 'var(--silver)';
  el.style.boxShadow = 'none';
}

interface KeyCellProps {
  endpointUrl: string;
  providerLabel: string;
  value: string;
  onCommit: (next: string) => void;
  disabled?: boolean;
}

function KeyCell({
  endpointUrl,
  providerLabel,
  value,
  onCommit,
  disabled,
}: KeyCellProps) {
  const [local, setLocal] = useState<string>(value);
  const [reveal, setReveal] = useState<boolean>(false);

  useEffect(() => {
    setLocal(value);
  }, [value, endpointUrl]);

  return (
    <div style={styles.keyWrap}>
      <input
        type={reveal ? 'text' : 'password'}
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onFocus={onInputFocus}
        onBlur={(e) => {
          resetInputStyle(e.currentTarget);
          if (local !== value) onCommit(local);
        }}
        disabled={disabled}
        placeholder="API key"
        autoComplete="off"
        spellCheck={false}
        aria-label={`API key for ${providerLabel}`}
        style={{ ...styles.input, ...styles.keyInput }}
      />
      <button
        type="button"
        style={styles.keyToggle}
        onClick={() => setReveal((r) => !r)}
        aria-label={reveal ? 'Hide API key' : 'Show API key'}
        aria-pressed={reveal}
        tabIndex={-1}
      >
        {reveal ? <EyeOffIcon size={16} /> : <EyeIcon size={16} />}
      </button>
    </div>
  );
}

interface TextFieldProps {
  value: string;
  onCommit: (next: string) => void;
  placeholder: string;
  ariaLabel: string;
  syncKey?: string;
}

function TextField({
  value,
  onCommit,
  placeholder,
  ariaLabel,
  syncKey,
}: TextFieldProps) {
  const [local, setLocal] = useState<string>(value);

  useEffect(() => {
    setLocal(value);
  }, [value, syncKey]);

  return (
    <input
      type="text"
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onFocus={onInputFocus}
      onBlur={(e) => {
        resetInputStyle(e.currentTarget);
        if (local !== value) onCommit(local);
      }}
      placeholder={placeholder}
      aria-label={ariaLabel}
      spellCheck={false}
      autoComplete="off"
      style={styles.input}
    />
  );
}

interface CustomRowProps {
  endpoint: CustomEndpoint;
  isLast: boolean;
  isActive: boolean;
  apiKey: string;
  model: string;
  modelsEntry: ProviderModelsEntry;
  onActivate: () => void;
  onPatch: (patch: Partial<Pick<CustomEndpoint, 'label' | 'url'>>) => void;
  onRemove: () => void;
  onSetKey: (next: string) => void;
  onSetModel: (next: string) => void;
  onRefreshModels: () => void;
}

function CustomRow({
  endpoint,
  isLast,
  isActive,
  apiKey,
  model,
  modelsEntry,
  onActivate,
  onPatch,
  onRemove,
  onSetKey,
  onSetModel,
  onRefreshModels,
}: CustomRowProps) {
  const hasUrl = endpoint.url.trim() !== '';
  const rowStyle = isLast ? { ...styles.row, ...styles.rowLast } : styles.row;
  const providerLabel = endpoint.label.trim() || 'custom endpoint';

  return (
    <div style={rowStyle}>
      <input
        type="radio"
        name="llm-active"
        value={endpoint.url}
        checked={isActive}
        onChange={onActivate}
        disabled={!hasUrl}
        style={styles.radio}
        aria-label={`Use ${providerLabel}`}
      />
      <div style={styles.middle}>
        <TextField
          value={endpoint.label}
          onCommit={(label) => onPatch({ label })}
          placeholder="Name (e.g. Local vLLM)"
          ariaLabel="Endpoint name"
          syncKey={endpoint.id}
        />
        <TextField
          value={endpoint.url}
          onCommit={(url) => onPatch({ url })}
          placeholder="Base URL (OpenAI-compatible)"
          ariaLabel="Endpoint URL"
          syncKey={endpoint.id}
        />
      </div>
      <ModelPickerCell
        endpointUrl={endpoint.url || endpoint.id}
        providerLabel={providerLabel}
        value={model}
        apiKey={apiKey}
        entry={modelsEntry}
        onCommit={onSetModel}
        onRefresh={onRefreshModels}
        disabled={!hasUrl}
      />
      <KeyCell
        endpointUrl={endpoint.url || endpoint.id}
        providerLabel={providerLabel}
        value={apiKey}
        onCommit={onSetKey}
        disabled={!hasUrl}
      />
      <button
        type="button"
        style={styles.removeButton}
        onClick={onRemove}
        aria-label={`Remove ${providerLabel}`}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = 'var(--danger-500)';
          e.currentTarget.style.borderColor = 'var(--mist)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = 'var(--steel)';
          e.currentTarget.style.borderColor = 'transparent';
        }}
      >
        <TrashIcon size={16} />
      </button>
    </div>
  );
}

interface LocalGemmaRowProps {
  isLast: boolean;
  isActive: boolean;
  selectedId: LocalGemmaId;
  onActivateConfirmed: () => void;
  onPickModel: (id: LocalGemmaId) => void;
}

function LocalGemmaRow({
  isLast,
  isActive,
  selectedId,
  onActivateConfirmed,
  onPickModel,
}: LocalGemmaRowProps) {
  const rowStyle = isLast ? { ...styles.row, ...styles.rowLast } : styles.row;
  const [gpuStatus, setGpuStatus] = useState<WebGpuStatus | null>(null);
  const [pendingDownload, setPendingDownload] = useState<LocalGemmaModel | null>(null);
  const [checkingCache, setCheckingCache] = useState(false);

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
    if (isActive) setPendingDownload(null);
  }, [isActive]);

  const supported = gpuStatus?.supported === true;
  const detecting = gpuStatus === null;
  const reason = gpuStatus?.reason;

  const handleRadioChange = (): void => {
    if (isActive) return;
    const model = getLocalGemmaModel(selectedId);
    if (!model) return;
    setCheckingCache(true);
    void (async () => {
      try {
        const cached = await isModelCached(model.url);
        if (cached) {
          setPendingDownload(null);
          onActivateConfirmed();
        } else {
          setPendingDownload(model);
        }
      } finally {
        setCheckingCache(false);
      }
    })();
  };

  const handleApply = (): void => {
    setPendingDownload(null);
    onActivateConfirmed();
  };

  const handleCancel = (): void => {
    setPendingDownload(null);
  };

  return (
    <div style={rowStyle}>
      <input
        type="radio"
        name="llm-active"
        value={LOCAL_GEMMA_ENDPOINT}
        checked={isActive}
        onChange={handleRadioChange}
        disabled={!supported || checkingCache}
        style={styles.radio}
        aria-label="Use Local Gemma 4 (WebGPU)"
        title={!supported && reason ? reason : undefined}
      />
      <div style={styles.middle}>
        <div style={styles.builtInLabel}>Local Gemma 4 (WebGPU)</div>
        <div style={styles.builtInUrl}>Runs in your browser via MediaPipe</div>
        {!supported && !detecting && reason ? (
          <p style={styles.localHint}>{reason}</p>
        ) : null}
        {supported ? (
          <p style={styles.localHint}>
            Models are downloaded once and cached. Tool support is best-effort on local models.
          </p>
        ) : null}
      </div>
      <div style={styles.modelWrap}>
        <select
          value={selectedId}
          onChange={(e) => onPickModel(e.target.value as LocalGemmaId)}
          disabled={!supported}
          aria-label="Local Gemma model"
          style={styles.selectEl}
        >
          {LOCAL_GEMMA_MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} — {formatGB(m.approxBytes)}
            </option>
          ))}
        </select>
        {pendingDownload ? (
          <div style={styles.localConfirm} role="alert">
            <p style={styles.localConfirmText}>
              {pendingDownload.label} is about {formatGB(pendingDownload.approxBytes)}.
              It will download and cache when you close Settings.
            </p>
            <div style={styles.localConfirmActions}>
              <button
                type="button"
                style={styles.localApplyButton}
                onClick={handleApply}
              >
                Apply
              </button>
              <button
                type="button"
                style={styles.localCancelButton}
                onClick={handleCancel}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}
      </div>
      <div style={styles.keyWrap} aria-hidden="true" />
      <div style={styles.removeSpacer} />
    </div>
  );
}

export default function LLMSettingsSection() {
  const {
    config,
    ready,
    setActiveEndpoint,
    setApiKey,
    setModel,
    addCustomEndpoint,
    updateCustomEndpoint,
    removeCustomEndpoint,
  } = useLLMConfig();
  const { getEntry, refresh } = useProviderModels();

  if (!ready) return null;

  const localActive = config.activeEndpoint === LOCAL_GEMMA_ENDPOINT;
  const localSelectedId =
    (config.models[LOCAL_GEMMA_ENDPOINT] as LocalGemmaId | undefined) ?? DEFAULT_LOCAL_GEMMA_ID;

  const handleLocalActivateConfirmed = (): void => {
    setActiveEndpoint(LOCAL_GEMMA_ENDPOINT);
    if (!config.models[LOCAL_GEMMA_ENDPOINT]) {
      setModel(LOCAL_GEMMA_ENDPOINT, localSelectedId);
    }
  };

  const handleLocalPickModel = (id: LocalGemmaId): void => {
    setModel(LOCAL_GEMMA_ENDPOINT, id);
  };

  const total = BUILT_IN_PROVIDERS.length + 1 + config.customEndpoints.length;

  return (
    <section style={styles.wrapper} aria-labelledby="llm-provider-heading">
      <style>{`@keyframes haw-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      <h3 id="llm-provider-heading" style={styles.sectionHeading}>
        LLM Provider
      </h3>
      <p style={styles.caption}>
        Select a provider and enter its API key. Keys are stored locally in your browser.
      </p>

      <div style={styles.list} role="radiogroup" aria-label="Active LLM provider">
        {BUILT_IN_PROVIDERS.map((provider, index) => {
          const isLast = index === total - 1;
          const rowStyle = isLast ? { ...styles.row, ...styles.rowLast } : styles.row;
          const isActive = config.activeEndpoint === provider.url;
          const apiKey = config.apiKeys[provider.url] ?? '';
          const model = config.models[provider.url] ?? '';
          return (
            <div key={provider.id} style={rowStyle}>
              <input
                type="radio"
                name="llm-active"
                value={provider.url}
                checked={isActive}
                onChange={() => setActiveEndpoint(provider.url)}
                style={styles.radio}
                aria-label={`Use ${provider.label}`}
              />
              <div style={styles.middle}>
                <div style={styles.builtInLabel}>{provider.label}</div>
                <div style={styles.builtInUrl}>{provider.url}</div>
              </div>
              <ModelPickerCell
                endpointUrl={provider.url}
                providerLabel={provider.label}
                value={model}
                apiKey={apiKey}
                entry={getEntry(provider.url)}
                onCommit={(next) => setModel(provider.url, next)}
                onRefresh={() => refresh(provider.url, apiKey)}
              />
              <KeyCell
                endpointUrl={provider.url}
                providerLabel={provider.label}
                value={apiKey}
                onCommit={(next) => setApiKey(provider.url, next)}
              />
              <div style={styles.removeSpacer} />
            </div>
          );
        })}

        <LocalGemmaRow
          isLast={BUILT_IN_PROVIDERS.length === total - 1}
          isActive={localActive}
          selectedId={localSelectedId}
          onActivateConfirmed={handleLocalActivateConfirmed}
          onPickModel={handleLocalPickModel}
        />

        {config.customEndpoints.map((endpoint, i) => {
          const isLast = BUILT_IN_PROVIDERS.length + 1 + i === total - 1;
          const isActive =
            endpoint.url !== '' && config.activeEndpoint === endpoint.url;
          const apiKey = endpoint.url ? config.apiKeys[endpoint.url] ?? '' : '';
          const model = endpoint.url ? config.models[endpoint.url] ?? '' : '';
          return (
            <CustomRow
              key={endpoint.id}
              endpoint={endpoint}
              isLast={isLast}
              isActive={isActive}
              apiKey={apiKey}
              model={model}
              modelsEntry={getEntry(endpoint.url || endpoint.id)}
              onActivate={() => setActiveEndpoint(endpoint.url)}
              onPatch={(patch) => updateCustomEndpoint(endpoint.id, patch)}
              onRemove={() => removeCustomEndpoint(endpoint.id)}
              onSetKey={(next) => {
                if (endpoint.url) setApiKey(endpoint.url, next);
              }}
              onSetModel={(next) => {
                if (endpoint.url) setModel(endpoint.url, next);
              }}
              onRefreshModels={() => {
                if (endpoint.url) refresh(endpoint.url, apiKey);
              }}
            />
          );
        })}
      </div>

      <button
        type="button"
        style={styles.addButton}
        onClick={() => addCustomEndpoint()}
      >
        <PlusIcon size={14} />
        Add custom endpoint
      </button>
    </section>
  );
}
