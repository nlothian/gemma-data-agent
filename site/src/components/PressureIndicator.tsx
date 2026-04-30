import { useEffect, useRef, useState } from 'react';

type PressureState = 'nominal' | 'fair' | 'serious' | 'critical';

interface PressureRecord {
  source: string;
  state: PressureState;
  time: number;
}

interface PressureObserverOptions {
  sampleInterval?: number;
}

interface PressureObserverInstance {
  observe(source: string, options?: PressureObserverOptions): Promise<void>;
  unobserve(source: string): void;
  disconnect(): void;
}

interface PressureObserverCtor {
  new (
    callback: (records: PressureRecord[], observer: PressureObserverInstance) => void,
  ): PressureObserverInstance;
  readonly knownSources: ReadonlyArray<string>;
}

declare global {
  interface Window {
    PressureObserver?: PressureObserverCtor;
  }
}

const HISTORY = 30;

const LEVEL: Record<PressureState, number> = {
  nominal: 0,
  fair: 1,
  serious: 2,
  critical: 3,
};

type Sample = PressureState | null;

function emptySamples(): Sample[] {
  return new Array(HISTORY).fill(null);
}

function pushSample(samples: Sample[], next: Sample): Sample[] {
  const out = samples.slice(1);
  out.push(next);
  return out;
}

function Sparkline({ label, samples }: { label: string; samples: Sample[] }) {
  const latest = samples[samples.length - 1];
  const title = `${label}: ${latest ?? 'unknown'}`;
  return (
    <div className="pressure-sparkline-wrap" title={title}>
      <span className="pressure-sparkline-label">{label}</span>
      <div className="pressure-sparkline" role="img" aria-label={title}>
        {samples.map((s, i) => {
          const cls = s
            ? `pressure-bar pressure-bar--${s}`
            : 'pressure-bar pressure-bar--empty';
          const heightPct = s ? ((LEVEL[s] + 1) / 4) * 100 : 0;
          return <span key={i} className={cls} style={{ height: `${heightPct}%` }} />;
        })}
      </div>
    </div>
  );
}

export default function PressureIndicator() {
  const Ctor = window.PressureObserver;
  const supported = typeof Ctor !== 'undefined';
  const [cpuSamples, setCpuSamples] = useState<Sample[]>(emptySamples);
  const [gpuSamples, setGpuSamples] = useState<Sample[]>(emptySamples);
  const [gpuAvailable, setGpuAvailable] = useState(false);
  const lastCpuRef = useRef<Sample>(null);
  const lastGpuRef = useRef<Sample>(null);

  useEffect(() => {
    if (!Ctor) return;

    console.log('[pressure] knownSources:', Ctor.knownSources);

    const observer = new Ctor((records) => {
      for (const r of records) {
        if (r.source === 'cpu') lastCpuRef.current = r.state;
        else if (r.source === 'gpu') lastGpuRef.current = r.state;
      }
    });

    observer
      .observe('cpu', { sampleInterval: 1000 })
      .then(() => console.log('[pressure] observe(cpu) → started'))
      .catch((err: Error) =>
        console.warn('[pressure] observe(cpu) →', err.name, err.message),
      );

    try {
      observer
        .observe('gpu', { sampleInterval: 1000 })
        .then(() => {
          console.log('[pressure] observe(gpu) → started');
          setGpuAvailable(true);
        })
        .catch((err: Error) =>
          console.warn('[pressure] observe(gpu) →', err.name, err.message),
        );
    } catch (err) {
      const e = err as Error;
      console.warn('[pressure] observe(gpu) → threw', e.name, e.message);
    }

    const tickId = window.setInterval(() => {
      setCpuSamples((prev) => pushSample(prev, lastCpuRef.current));
      setGpuSamples((prev) => pushSample(prev, lastGpuRef.current));
    }, 1000);

    return () => {
      window.clearInterval(tickId);
      observer.disconnect();
    };
  }, [Ctor]);

  if (!supported) return null;

  return (
    <div className="pressure-indicator" aria-label="System pressure">
      <Sparkline label="CPU" samples={cpuSamples} />
      {gpuAvailable && <Sparkline label="GPU" samples={gpuSamples} />}
    </div>
  );
}
