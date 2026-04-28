import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircleIcon,
  EyeIcon,
  EyeOffIcon,
  LoaderIcon,
  PlusIcon,
  RefreshIcon,
  TrashIcon,
} from './Icons';
import useLLMConfig from '../hooks/useLLMConfig';
import useProviderModels, {
  type ProviderModelsEntry,
} from '../hooks/useProviderModels';
import { BUILT_IN_PROVIDERS, type CustomEndpoint } from '../types/llm';

const CUSTOM_SENTINEL = '__custom__';

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
};

function onInputFocus(e: React.FocusEvent<HTMLInputElement>): void {
  e.currentTarget.style.borderColor = 'var(--aqua-500)';
  e.currentTarget.style.boxShadow = '0 0 0 3px var(--aqua-50)';
}

function resetInputStyle(el: HTMLInputElement): void {
  el.style.borderColor = 'var(--silver)';
  el.style.boxShadow = 'none';
}

interface ModelCellProps {
  endpointUrl: string;
  providerLabel: string;
  value: string;
  apiKey: string;
  entry: ProviderModelsEntry;
  onCommit: (next: string) => void;
  onRefresh: () => void;
  disabled?: boolean;
}

function splitModelId(id: string): [string, string] {
  const i = id.indexOf('/');
  return i === -1 ? ['', id] : [id.slice(0, i), id.slice(i + 1)];
}

function ModelCell({
  endpointUrl,
  providerLabel,
  value,
  apiKey,
  entry,
  onCommit,
  onRefresh,
  disabled,
}: ModelCellProps) {
  const [mode, setMode] = useState<'select' | 'custom'>('select');
  const [local, setLocal] = useState<string>(value);
  const isOpenRouter = endpointUrl.includes('openrouter.ai');
  const [valueProvider, valueModel] = splitModelId(value);
  const [draftProvider, setDraftProvider] = useState<string>(valueProvider);

  useEffect(() => {
    setLocal(value);
  }, [value, endpointUrl]);

  useEffect(() => {
    setDraftProvider(splitModelId(value)[0]);
  }, [value, endpointUrl]);

  useEffect(() => {
    if (disabled) return;
    if (entry.status !== 'idle') return;
    if (!endpointUrl) return;
    if (apiKey === '' && !isOpenRouter) return;
    onRefresh();
  }, [endpointUrl, apiKey, entry.status, disabled, isOpenRouter, onRefresh]);

  const loading = entry.status === 'loading';
  const models = entry.status === 'success' ? entry.models : [];
  const showSynthetic =
    entry.status === 'success' && value !== '' && !models.includes(value);

  const useSplit = isOpenRouter && mode === 'select' && entry.status === 'success';

  const providers = useMemo(() => {
    if (!useSplit) return [];
    const set = new Set<string>();
    for (const m of models) {
      const [p] = splitModelId(m);
      if (p) set.add(p);
    }
    return Array.from(set).sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: 'base' }),
    );
  }, [useSplit, models]);

  const modelsInDraftProvider = useMemo(() => {
    if (!useSplit || !draftProvider) return [];
    const list: string[] = [];
    for (const m of models) {
      const [p, rest] = splitModelId(m);
      if (p === draftProvider) list.push(rest);
    }
    return list;
  }, [useSplit, models, draftProvider]);

  const selectedModelInDraft = draftProvider === valueProvider ? valueModel : '';
  const showSyntheticProvider =
    useSplit && valueProvider !== '' && !providers.includes(valueProvider);
  const showSyntheticModel =
    useSplit &&
    draftProvider === valueProvider &&
    valueModel !== '' &&
    !modelsInDraftProvider.includes(valueModel);

  const handleSelectChange = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    const next = e.target.value;
    if (next === CUSTOM_SENTINEL) {
      setMode('custom');
      return;
    }
    if (next !== value) onCommit(next);
  };

  const handleProviderChange = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    const next = e.target.value;
    if (next === CUSTOM_SENTINEL) {
      setMode('custom');
      return;
    }
    setDraftProvider(next);
  };

  const handleModelInDraftChange = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    const next = e.target.value;
    if (next === '' || !draftProvider) return;
    const full = `${draftProvider}/${next}`;
    if (full !== value) onCommit(full);
  };

  return (
    <div style={styles.modelWrap}>
      {mode === 'select' ? (
        <>
          {useSplit ? (
            <div style={styles.modelRowInner}>
              <div style={styles.splitStack}>
                <select
                  value={draftProvider}
                  onChange={handleProviderChange}
                  disabled={disabled || loading}
                  aria-label={`Model provider for ${providerLabel}`}
                  style={styles.selectEl}
                >
                  {draftProvider === '' && (
                    <option value="" disabled>
                      -- Provider --
                    </option>
                  )}
                  {showSyntheticProvider && (
                    <option value={valueProvider}>{valueProvider} (not in list)</option>
                  )}
                  {providers.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                  <option value={CUSTOM_SENTINEL}>Custom…</option>
                </select>
                <select
                  value={selectedModelInDraft}
                  onChange={handleModelInDraftChange}
                  disabled={disabled || loading || !draftProvider}
                  aria-label={`Model for ${providerLabel}`}
                  style={styles.selectEl}
                >
                  {selectedModelInDraft === '' && (
                    <option value="" disabled>
                      {draftProvider ? '-- Model --' : '-- Pick provider first --'}
                    </option>
                  )}
                  {showSyntheticModel && (
                    <option value={valueModel}>{valueModel} (not in list)</option>
                  )}
                  {modelsInDraftProvider.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                onClick={onRefresh}
                disabled={disabled || loading}
                aria-label={`Refresh models for ${providerLabel}`}
                style={styles.refreshButton}
              >
                {loading ? (
                  <LoaderIcon size={14} style={styles.spinnerIcon} />
                ) : (
                  <RefreshIcon size={14} />
                )}
              </button>
            </div>
          ) : (
            <div style={styles.modelRowInner}>
              <select
                value={value}
                onChange={handleSelectChange}
                disabled={disabled || loading}
                aria-label={`Model for ${providerLabel}`}
                style={styles.selectEl}
              >
                {value === '' && (
                  <option value="" disabled>
                    {loading ? 'Loading models…' : '-- Select a model --'}
                  </option>
                )}
                {showSynthetic && (
                  <option value={value}>{value} (not in list)</option>
                )}
                {models.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
                <option value={CUSTOM_SENTINEL}>Custom…</option>
              </select>
              <button
                type="button"
                onClick={onRefresh}
                disabled={disabled || loading}
                aria-label={`Refresh models for ${providerLabel}`}
                style={styles.refreshButton}
              >
                {loading ? (
                  <LoaderIcon size={14} style={styles.spinnerIcon} />
                ) : (
                  <RefreshIcon size={14} />
                )}
              </button>
            </div>
          )}
          {entry.status === 'error' && (
            <div
              style={styles.errorText}
              title={entry.message}
              role="alert"
            >
              <AlertCircleIcon size={12} />
              <span
                style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {entry.message}
              </span>
            </div>
          )}
        </>
      ) : (
        <>
          <input
            type="text"
            value={local}
            onChange={(e) => setLocal(e.target.value)}
            onFocus={onInputFocus}
            onBlur={(e) => {
              resetInputStyle(e.currentTarget);
              if (local !== value) onCommit(local);
            }}
            disabled={disabled}
            placeholder="Model"
            autoComplete="off"
            spellCheck={false}
            aria-label={`Model for ${providerLabel}`}
            style={styles.input}
          />
          <button
            type="button"
            onClick={() => setMode('select')}
            style={styles.customLink}
          >
            Use list
          </button>
        </>
      )}
    </div>
  );
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
      <ModelCell
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

  const total = BUILT_IN_PROVIDERS.length + config.customEndpoints.length;

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
              <ModelCell
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

        {config.customEndpoints.map((endpoint, i) => {
          const isLast = BUILT_IN_PROVIDERS.length + i === total - 1;
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
