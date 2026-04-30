import { useEffect, useMemo, useState } from 'react';
import { AlertCircleIcon, LoaderIcon, RefreshIcon } from './Icons';
import type { ProviderModelsEntry } from '../hooks/useProviderModels';

const CUSTOM_SENTINEL = '__custom__';

const styles = {
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
};

function onInputFocus(e: React.FocusEvent<HTMLInputElement>): void {
  e.currentTarget.style.borderColor = 'var(--aqua-500)';
  e.currentTarget.style.boxShadow = '0 0 0 3px var(--aqua-50)';
}

function resetInputStyle(el: HTMLInputElement): void {
  el.style.borderColor = 'var(--silver)';
  el.style.boxShadow = 'none';
}

function splitModelId(id: string): [string, string] {
  const i = id.indexOf('/');
  return i === -1 ? ['', id] : [id.slice(0, i), id.slice(i + 1)];
}

export interface ModelPickerCellProps {
  endpointUrl: string;
  providerLabel: string;
  value: string;
  apiKey: string;
  entry: ProviderModelsEntry;
  onCommit: (next: string) => void;
  onRefresh: () => void;
  disabled?: boolean;
}

/**
 * Reusable model-picker cell: dropdown of available models for the given
 * endpoint, with a refresh button and a "Custom…" escape hatch for
 * free-text input. For OpenRouter, splits the dropdown into a
 * provider+model pair (e.g. "anthropic" / "claude-sonnet-4.5") to make
 * navigation easier.
 *
 * Auto-fetches the model list on first render when the entry is idle.
 *
 * Originally inlined in `LLMSettingsSection.tsx`; extracted so the
 * data-gen page can reuse the same UX for Teacher / Judge selection.
 */
export default function ModelPickerCell({
  endpointUrl,
  providerLabel,
  value,
  apiKey,
  entry,
  onCommit,
  onRefresh,
  disabled,
}: ModelPickerCellProps) {
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
