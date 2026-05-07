import React, { useState, useEffect, useCallback } from 'react';
import DashboardView, { type DashboardBenchmarkStats, type DashboardConfig, type DashboardEngineStatus, type DashboardServices, type DashboardStats, type DashboardTab, type Toast } from './DashboardView.js';

const API_BASE = 'http://127.0.0.1:8080';

const getMachineStatus = (status: DashboardEngineStatus): DashboardServices['mlx'] => {
  if (status === 'running') return 'running';
  if (status === 'starting') return 'starting';
  return 'stopped';
};

const scheduleToastRemoval = (
  setToasts: React.Dispatch<React.SetStateAction<Toast[]>>,
  id: number,
): void => {
  setTimeout(function removeToastLater() {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, 4000);
};

type EngineStatusResponse = {
  status: DashboardEngineStatus;
};

export default function App() {
  const [activeTab, setActiveTab] = useState<DashboardTab>('metrics');
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [bench, setBench] = useState<DashboardBenchmarkStats>({ astTime: 0, ragTime: 0, ttft: 0, tps: 0, totalTokens: 0, totalTime: 0 });
  const [config, setConfig] = useState<DashboardConfig>({ modelPath: '', tokenBudget: 16384 });
  const [isSaving, setIsSaving] = useState(false);
  const [engineStatus, setEngineStatus] = useState<DashboardEngineStatus>('stopped');
  const [logs, setLogs] = useState<string[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [services, setServices] = useState<DashboardServices>({ gateway: 'offline', mlx: 'stopped', daemon: 'stopped' });
  const [liveTtft, setLiveTtft] = useState(0);
  const [liveTotalTime, setLiveTotalTime] = useState(0);

  const addToast = useCallback((message: string, type: Toast['type'] = 'info') => {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    setToasts((current) => [...current, { id, message, type }]);
    scheduleToastRemoval(setToasts, id);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const fetchAll = useCallback(async () => {
    let gwOnline = false;

    try {
      const response = await fetch(`${API_BASE}/aether/engine/status`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) {
        gwOnline = true;
        const { status } = (await response.json()) as EngineStatusResponse;
        setEngineStatus(status);
        setServices((current) => ({
          ...current,
          gateway: 'online',
          mlx: getMachineStatus(status),
          daemon: getMachineStatus(status),
        }));
      }
    } catch {
      if (services.gateway === 'online') addToast('Gateway went offline!', 'error');
      setServices((current) => ({ ...current, gateway: 'offline', mlx: 'stopped', daemon: 'stopped' }));
    }

    if (!gwOnline) return;

    try {
      const response = await fetch(`${API_BASE}/aether/stats`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) {
        const data = await response.json();
        setStats(data);
        if (data.last_benchmark) setBench(data.last_benchmark);
      }
    } catch {}
  }, [services.gateway, addToast]);

  const fetchLogs = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/aether/engine/logs`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) setLogs((await response.json()).logs);
    } catch {}
  }, []);

  const fetchConfig = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/aether/config`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) setConfig(await response.json());
    } catch {}
  }, []);

  const pickFolder = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/aether/util/pick-folder`, { method: 'POST' });
      if (response.ok) {
        const { path } = await response.json();
        if (path) setConfig((current) => ({ ...current, modelPath: path }));
      }
    } catch {
      addToast('Failed to trigger folder picker', 'error');
    }
  }, [addToast]);

  useEffect(() => {
    void fetchAll();
    void fetchConfig();
    const interval = setInterval(() => {
      void fetchAll();
    }, 1000);

    return () => clearInterval(interval);
  }, [fetchAll, fetchConfig]);

  useEffect(() => {
    if (activeTab !== 'logs') return;

    void fetchLogs();
    const interval = setInterval(() => {
      void fetchLogs();
    }, 3000);

    return () => clearInterval(interval);
  }, [activeTab, fetchLogs]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (stats?.current_request_start) {
        const elapsed = Date.now() - stats.current_request_start;
        setLiveTotalTime(elapsed / 1000);
        setLiveTtft(bench.ttft === 0 ? elapsed : 0);
      } else {
        setLiveTotalTime(0);
        setLiveTtft(0);
      }
    }, 100);

    return () => clearInterval(interval);
  }, [stats?.current_request_start, bench.ttft]);

  const toggleEngine = useCallback(async () => {
    if (services.gateway === 'offline') {
      addToast('Gateway is offline. Start Aether first.', 'error');
      return;
    }

    if (engineStatus === 'starting') return;

    const action = engineStatus === 'running' ? 'stop' : 'start';
    setEngineStatus(action === 'start' ? 'starting' : 'stopped');

    try {
      await fetch(`${API_BASE}/aether/engine/${action}`, { method: 'POST' });
      addToast(action === 'start' ? 'Engine starting up...' : 'Engine shutting down...', 'info');
    } catch {
      addToast('Failed to contact Gateway', 'error');
    }
  }, [services.gateway, engineStatus, addToast]);

  const persistConfig = useCallback(async (): Promise<void> => {
    setIsSaving(true);

    try {
      const response = await fetch(`${API_BASE}/aether/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });

      if (response.ok) {
        addToast('Configuration saved! Restart Aether to apply.', 'success');
      } else {
        addToast('Failed to save configuration.', 'error');
      }
    } catch {
      addToast('Network error — is the Gateway running?', 'error');
    } finally {
      setIsSaving(false);
    }
  }, [config, addToast]);

  const handleSaveConfig = (event: React.SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void persistConfig();
  };

  return (
    <DashboardView
      activeTab={activeTab}
      setActiveTab={setActiveTab}
      stats={stats}
      bench={bench}
      config={config}
      setConfig={setConfig}
      isSaving={isSaving}
      engineStatus={engineStatus}
      logs={logs}
      toasts={toasts}
      services={services}
      liveTtft={liveTtft}
      liveTotalTime={liveTotalTime}
      onDismissToast={dismissToast}
      onToggleEngine={toggleEngine}
      onPickFolder={pickFolder}
      onSaveConfig={handleSaveConfig}
    />
  );
}
