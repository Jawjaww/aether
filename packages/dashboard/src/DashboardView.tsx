import React, { useEffect, useRef, useState } from 'react';
import {
  Activity, Settings, Cpu, Database, Clock, RefreshCw, Save,
  Zap, Box, Server, Power, AlertTriangle, CheckCircle, X, WifiOff,
  FolderOpen, List, Terminal, Brain
} from 'lucide-react';

export type DashboardTab = 'metrics' | 'history' | 'indexing' | 'logs' | 'config';
export type DashboardEngineStatus = 'stopped' | 'starting' | 'running';
export type DashboardServiceConnection = 'online' | 'offline';
export type DashboardMachineStatus = 'running' | 'stopped' | 'starting';
export type DashboardLogCategory = 'all' | 'startup' | 'index' | 'rerank' | 'core' | 'mlx' | 'gateway' | 'error';

export interface DashboardBenchmarkStats {
  astTime: number;
  ragTime: number;
  rerankTime?: number;
  ttft: number;
  tps: number;
  totalTokens: number;
  totalTime: number;
}

export interface DashboardConfig {
  modelPath: string;
  tokenBudget: number;
}

export interface DashboardStats {
  uptime_sec?: number;
  requests_total?: number;
  requests_per_min?: number;
  latency_p50_ms?: number;
  latency_avg_ms?: number;
  tokens_saved_pct?: number;
  tokens_removed_total?: number;
  tokens_injected_total?: number;
  queue_pending?: number;
  queue_last_sec?: number;
  files_indexed?: number;
  index_size_bytes?: number;
  requests_ok?: number;
  requests_error?: number;
  aether_bypass?: number;
  history?: Array<Record<string, any>>;
  current_request_start?: number;
  last_benchmark?: DashboardBenchmarkStats;
}

export interface DashboardServices {
  gateway: DashboardServiceConnection;
  mlx: DashboardMachineStatus;
  daemon: DashboardMachineStatus;
}

export interface Toast {
  id: number;
  message: string;
  type: 'error' | 'success' | 'info';
}

const getToastClassName = (type: Toast['type']): string => {
  if (type === 'error') return 'bg-rose-950/90 border-rose-500/30 text-rose-200';
  if (type === 'success') return 'bg-emerald-950/90 border-emerald-500/30 text-emerald-200';
  return 'bg-zinc-900/90 border-zinc-700/50 text-zinc-200';
};

const getToastIcon = (type: Toast['type']) => {
  if (type === 'error') return <AlertTriangle className="w-4 h-4 text-rose-400 flex-shrink-0" />;
  if (type === 'success') return <CheckCircle className="w-4 h-4 text-emerald-400 flex-shrink-0" />;
  return <Zap className="w-4 h-4 text-indigo-400 flex-shrink-0" />;
};

const getServiceTone = (state: DashboardServices[keyof DashboardServices]): string => {
  if (state === 'online' || state === 'running') return 'text-emerald-400';
  if (state === 'starting') return 'text-amber-400';
  return 'text-rose-400';
};

const getPowerClassName = (state: DashboardEngineStatus): string => {
  if (state === 'running') {
    return 'bg-rose-500/10 text-rose-500 border border-rose-500/20 hover:bg-rose-500/20';
  }

  if (state === 'starting') {
    return 'bg-amber-500/10 text-amber-500 border border-amber-500/20 cursor-wait';
  }

  return 'bg-emerald-500/10 text-emerald-500 border border-emerald-500/20 hover:bg-emerald-500/20';
};

const getPowerLabel = (state: DashboardEngineStatus): string => {
  if (state === 'running') return 'POWER OFF';
  if (state === 'starting') return 'BOOTING...';
  return 'POWER ON';
};

const getHeaderTitle = (tab: DashboardTab): string => {
  if (tab === 'metrics') return 'Gateway Metrics';
  if (tab === 'history') return 'Benchmark History';
  if (tab === 'indexing') return 'Indexing State';
  if (tab === 'logs') return 'Engine Logs';
  return 'Settings';
};

const getTabButtonClass = (active: boolean): string => (
  active
    ? 'bg-indigo-500/10 text-indigo-400 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.05)]'
    : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/50'
);

const getStatusDotClass = (state: DashboardServices[keyof DashboardServices]): string => {
  if (state === 'online' || state === 'running') return 'bg-emerald-500 animate-pulse';
  if (state === 'starting') return 'bg-amber-500 animate-bounce';
  return 'bg-rose-500';
};

const getLogClassName = (log: string): string => {
  if (log.includes('[Error') || log.includes('Exception') || log.includes('Failed')) return 'text-rose-400';
  if (log.includes('[MLX]')) return 'text-blue-400';
  if (log.includes('[Core]')) return 'text-emerald-400';
  return 'text-zinc-300';
};

const getLogCategory = (log: string): DashboardLogCategory => {
  if (log.includes('[Error') || log.includes('Exception') || log.includes('Failed') || log.includes('❌')) return 'error';
  if (log.includes('[System] Starting') || log.includes('Starting MLX server') || log.includes('Daemon ready') || log.includes('Initializing engines')) return 'startup';
  if (log.includes('[System] Starting Core Daemon') || log.includes('[Core]') || log.includes('Index diff') || log.includes('Indexed batch') || log.includes('Background indexing')) return 'core';
  if (log.includes('[MLX]')) return 'mlx';
  if (log.includes('[Gateway]') || log.includes('Gateway')) return 'gateway';
  if (log.includes('Reranker') || log.includes('[Reranker]') || log.includes('rerank')) return 'rerank';
  if (log.includes('index') || log.includes('Index')) return 'index';
  return 'all';
};

const LOG_CATEGORY_LABELS: Record<DashboardLogCategory, string> = {
  all: 'All',
  startup: 'Startup',
  index: 'Index',
  rerank: 'Rerank',
  core: 'Core',
  mlx: 'MLX',
  gateway: 'Gateway',
  error: 'Errors',
};

const LOG_CATEGORY_ORDER: DashboardLogCategory[] = ['all', 'startup', 'index', 'rerank', 'core', 'mlx', 'gateway', 'error'];

const formatBytes = (bytes: number): string => {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${Number.parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
};

const formatUptime = (seconds: number): string => {
  if (!seconds) return '0s';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
};

const getIndexingStateLabel = (queuePending: number, filesIndexed: number): string => {
  if (queuePending > 0) return 'Indexing in progress';
  if (filesIndexed > 0) return 'Index ready';
  return 'Waiting for first scan';
};

const getIndexingStateTone = (queuePending: number, filesIndexed: number): string => {
  if (queuePending > 0) return 'text-amber-400';
  if (filesIndexed > 0) return 'text-emerald-400';
  return 'text-zinc-400';
};

const StatusDot = ({ state }: { state: DashboardServices[keyof DashboardServices] }) => (
  <div className={`w-2 h-2 rounded-full flex-shrink-0 ${getStatusDotClass(state)}`} />
);

type DashboardEmptyStateProps = {
  icon: React.ComponentType<{ className?: string }>;
  message: string;
};

const DashboardEmptyState = ({ icon: Icon, message }: DashboardEmptyStateProps) => (
  <div className="h-64 flex flex-col items-center justify-center text-zinc-500 border border-zinc-800/50 rounded-2xl bg-zinc-900/20 border-dashed">
    <Icon className="w-8 h-8 mb-3 opacity-50" />
    <p>{message}</p>
  </div>
);

type ToastStackProps = {
  toasts: Toast[];
  onDismissToast: (id: number) => void;
};

const ToastStack = ({ toasts, onDismissToast }: ToastStackProps) => (
  <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
    {toasts.map((toast) => (
      <div
        key={toast.id}
        className={`flex items-center gap-3 px-4 py-3 rounded-xl border shadow-2xl backdrop-blur-xl text-sm font-medium pointer-events-auto transition-all animate-in slide-in-from-right-4 fade-in duration-300 ${getToastClassName(toast.type)}`}
      >
        {getToastIcon(toast.type)}
        <span>{toast.message}</span>
        <button onClick={() => onDismissToast(toast.id)} className="ml-1 opacity-60 hover:opacity-100">
          <X className="w-3 h-3" />
        </button>
      </div>
    ))}
  </div>
);

type SidebarProps = {
  activeTab: DashboardTab;
  setActiveTab: (tab: DashboardTab) => void;
  services: DashboardServices;
  engineStatus: DashboardEngineStatus;
  onToggleEngine: () => void;
};

const Sidebar = ({ activeTab, setActiveTab, services, engineStatus, onToggleEngine }: SidebarProps) => (
  <aside className="w-64 border-r border-zinc-800/50 bg-zinc-950/50 flex flex-col backdrop-blur-xl">
    <div className="h-16 flex items-center px-6 border-b border-zinc-800/50">
      <div className="flex items-center gap-2 text-indigo-400 font-bold text-lg tracking-wide">
        <Zap className="w-5 h-5 fill-indigo-500/20" />
        AETHER
      </div>
    </div>

    <nav className="flex-1 p-4 space-y-2">
      <button onClick={() => setActiveTab('metrics')} className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-200 ${getTabButtonClass(activeTab === 'metrics')}`}>
        <Activity className="w-4 h-4" />
        <span className="font-medium text-sm">Realtime Metrics</span>
      </button>

      <button onClick={() => setActiveTab('history')} className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-200 ${getTabButtonClass(activeTab === 'history')}`}>
        <List className="w-4 h-4" />
        <span className="font-medium text-sm">Benchmark History</span>
      </button>

      <button onClick={() => setActiveTab('indexing')} className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-200 ${getTabButtonClass(activeTab === 'indexing')}`}>
        <Box className="w-4 h-4" />
        <span className="font-medium text-sm">Indexing State</span>
      </button>

      <button onClick={() => setActiveTab('logs')} className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-200 ${getTabButtonClass(activeTab === 'logs')}`}>
        <Terminal className="w-4 h-4" />
        <span className="font-medium text-sm">Engine Logs</span>
      </button>

      <button onClick={() => setActiveTab('config')} className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-200 ${getTabButtonClass(activeTab === 'config')}`}>
        <Settings className="w-4 h-4" />
        <span className="font-medium text-sm">Configuration</span>
      </button>
    </nav>

    <div className="p-4 border-t border-zinc-800/50 space-y-3">
      <div className="space-y-1.5 p-3 rounded-xl bg-zinc-900/50 border border-zinc-800/50">
        <p className="text-[10px] uppercase tracking-widest text-zinc-500 font-semibold mb-2">Services</p>
        {[
          { label: 'Gateway', icon: Server, state: services.gateway },
          { label: 'MLX Server', icon: Cpu, state: services.mlx },
          { label: 'Core Daemon', icon: Database, state: services.daemon },
        ].map(({ label, icon: Icon, state }) => (
          <div key={label} className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-2 text-zinc-400">
              <Icon className="w-3 h-3" />
              {label}
            </div>
            <div className="flex items-center gap-1.5">
              <StatusDot state={state} />
              <span className={`capitalize ${getServiceTone(state)}`}>{state}</span>
            </div>
          </div>
        ))}
      </div>

      <button
        onClick={onToggleEngine}
        disabled={engineStatus === 'starting' || services.gateway === 'offline'}
        className={`w-full py-3 rounded-xl flex items-center justify-center gap-2 font-bold text-sm shadow-lg transition-all disabled:opacity-40 disabled:cursor-not-allowed ${getPowerClassName(engineStatus)}`}
      >
        <Power className={`w-4 h-4 ${engineStatus === 'starting' ? 'animate-pulse' : ''}`} />
        {getPowerLabel(engineStatus)}
      </button>
    </div>
  </aside>
);

type LiveBadgeProps = {
  visible: boolean;
};

const LiveUpdatesBadge = ({ visible }: LiveBadgeProps) => {
  if (!visible) return null;

  return (
    <div className="flex items-center gap-2 text-xs font-medium text-emerald-400 bg-emerald-400/10 px-3 py-1.5 rounded-full border border-emerald-400/20">
      <RefreshCw className="w-3 h-3 animate-spin-slow" />
      Live Updates
    </div>
  );
};

type OfflineBannerProps = {
  visible: boolean;
};

const GatewayOfflineBanner = ({ visible }: OfflineBannerProps) => {
  if (!visible) return null;

  return (
    <div className="mb-6 flex items-start gap-4 p-5 rounded-2xl bg-rose-950/40 border border-rose-500/30 text-rose-200 animate-in fade-in duration-500">
      <WifiOff className="w-6 h-6 text-rose-400 flex-shrink-0 mt-0.5" />
      <div>
        <p className="font-semibold text-rose-300 mb-1">Gateway Offline</p>
        <p className="text-sm text-rose-300/70 mb-3">The Aether Gateway is not reachable on <code className="bg-rose-500/20 px-1 rounded">http://127.0.0.1:8080</code>. Start it to use the dashboard.</p>
        <code className="block text-xs bg-black/40 border border-rose-500/20 rounded-lg px-3 py-2 text-rose-300 font-mono">./start-aether.sh</code>
      </div>
    </div>
  );
};

type MetricCardProps = {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  value: React.ReactNode;
  valueClassName: string;
  glowClassName: string;
  iconClassName: string;
  note?: React.ReactNode;
};

const MetricCard = ({ title, icon: Icon, value, valueClassName, glowClassName, iconClassName, note }: MetricCardProps) => (
  <div className="p-5 rounded-2xl bg-zinc-900/40 border border-zinc-800/50 shadow-lg backdrop-blur-sm relative overflow-hidden group">
    <div className={`absolute top-0 right-0 w-32 h-32 rounded-full blur-3xl -mr-10 -mt-10 transition-colors group-hover:opacity-100 ${glowClassName}`} />
    <div className="flex items-center gap-3 text-zinc-400 mb-2">
      <Icon className={`w-4 h-4 ${iconClassName}`} />
      <span className="text-sm font-medium">{title}</span>
    </div>
    <div className={valueClassName}>{value}</div>
    {note ? <div className="text-xs text-zinc-500 mt-1">{note}</div> : null}
  </div>
);

type MetricsTabContentProps = {
  stats: DashboardStats;
  bench: DashboardBenchmarkStats;
  liveTtft: number;
  liveTotalTime: number;
};

const MetricsTabContent = ({ stats, bench, liveTtft, liveTotalTime }: MetricsTabContentProps) => {
  const queuePending = stats.queue_pending ?? 0;
  const queueLastSeen = stats.queue_last_sec ?? 0;
  const rerankTime = bench.rerankTime ?? 0;
  const totalTime = liveTotalTime > 0 ? liveTotalTime : bench.totalTime || 0;
  const totalTimeMinutes = Math.floor(totalTime / 60);
  const totalTimeSeconds = Math.floor(totalTime % 60);
  const totalTimeDisplay = `${totalTimeMinutes > 0 ? totalTimeMinutes + 'm ' : ''}${totalTimeSeconds}s`;
  const ttftValue = liveTtft > 0 ? (liveTtft / 1000).toFixed(2) : (bench.ttft / 1000).toFixed(2);

  const statusCards = [
    {
      id: 'uptime',
      title: 'Uptime',
      icon: Clock,
      value: formatUptime(stats.uptime_sec ?? 0),
      valueClassName: 'text-3xl font-bold tracking-tight text-zinc-100',
      glowClassName: 'bg-indigo-500/5 group-hover:bg-indigo-500/10',
      iconClassName: 'text-indigo-400',
    },
    {
      id: 'requests',
      title: 'Total Requests',
      icon: Activity,
      value: stats.requests_total ?? 0,
      valueClassName: 'text-3xl font-bold tracking-tight text-zinc-100',
      glowClassName: 'bg-emerald-500/5 group-hover:bg-emerald-500/10',
      iconClassName: 'text-emerald-400',
      note: `${stats.requests_per_min ?? 0} req/min`,
    },
    {
      id: 'latency',
      title: 'P50 Latency',
      icon: Cpu,
      value: (
        <>
          {((stats.latency_p50_ms ?? 0) / 1000).toFixed(2)} <span className="text-lg text-zinc-500">s</span>
        </>
      ),
      valueClassName: 'text-3xl font-bold tracking-tight text-zinc-100',
      glowClassName: 'bg-amber-500/5 group-hover:bg-amber-500/10',
      iconClassName: 'text-amber-400',
      note: `Avg: ${((stats.latency_avg_ms ?? 0) / 1000).toFixed(2)} s`,
    },
    {
      id: 'saved',
      title: 'Tokens Saved',
      icon: Database,
      value: `${stats.tokens_saved_pct ?? 0}%`,
      valueClassName: 'text-3xl font-bold tracking-tight text-emerald-400',
      glowClassName: 'bg-rose-500/5 group-hover:bg-rose-500/10',
      iconClassName: 'text-rose-400',
      note: `${stats.tokens_removed_total ?? 0} removed / ${stats.tokens_injected_total ?? 0} injected`,
    },
  ];

  const benchmarkCards = [
    {
      id: 'context',
      title: 'Context Engine (AST/RAG)',
      icon: Box,
      value: `${((bench.astTime + bench.ragTime) / 1000).toFixed(2)}s`,
      valueClassName: 'text-2xl font-mono text-zinc-100',
      glowClassName: 'bg-indigo-500/5',
      iconClassName: 'text-indigo-400',
    },
    {
      id: 'ttft',
      title: 'TTFT (Latency)',
      icon: Cpu,
      value: `${ttftValue}s`,
      valueClassName: `text-2xl font-mono ${liveTtft > 0 ? 'text-amber-400' : 'text-zinc-100'}`,
      glowClassName: 'bg-amber-500/5',
      iconClassName: 'text-amber-400',
    },
    {
      id: 'speed',
      title: 'Generation Speed',
      icon: Zap,
      value: (
        <div className="flex items-baseline gap-1">
          <p className="text-2xl font-mono text-emerald-400">{bench.tps}</p>
          <span className="text-[10px] text-zinc-500 uppercase">tok/sec</span>
        </div>
      ),
      valueClassName: 'text-2xl font-mono text-zinc-100',
      glowClassName: 'bg-emerald-500/5',
      iconClassName: 'text-emerald-400',
    },
    {
      id: 'reranker',
      title: 'Reranker',
      icon: Brain,
      value: `${rerankTime}ms`,
      valueClassName: `text-2xl font-mono ${rerankTime > 0 ? 'text-purple-300' : 'text-zinc-500'}`,
      glowClassName: 'bg-purple-500/5',
      iconClassName: 'text-purple-400',
    },
    {
      id: 'total',
      title: 'Total Time',
      icon: Clock,
      value: totalTimeDisplay,
      valueClassName: 'text-2xl font-mono text-zinc-100',
      glowClassName: 'bg-indigo-500/5',
      iconClassName: 'text-indigo-400',
    },
  ];

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="px-4 py-3 rounded-xl bg-zinc-900/35 border border-zinc-800/50 flex items-center justify-between gap-3">
          <span className="text-xs uppercase tracking-widest text-zinc-500 font-semibold">Queue</span>
          <span className="text-sm font-mono text-zinc-100">{queuePending} pending</span>
        </div>
        <div className="px-4 py-3 rounded-xl bg-zinc-900/35 border border-zinc-800/50 flex items-center justify-between gap-3">
          <span className="text-xs uppercase tracking-widest text-zinc-500 font-semibold">Last Request</span>
          <span className="text-sm font-mono text-zinc-100">{queueLastSeen > 0 ? `${formatUptime(queueLastSeen)} ago` : 'now'}</span>
        </div>
        <div className="px-4 py-3 rounded-xl bg-zinc-900/35 border border-zinc-800/50 flex items-center justify-between gap-3">
          <span className="text-xs uppercase tracking-widest text-zinc-500 font-semibold">Reranker</span>
          <span className={`text-sm font-mono ${rerankTime > 0 ? 'text-purple-300' : 'text-zinc-500'}`}>{rerankTime > 0 ? `${rerankTime}ms` : 'idle'}</span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {statusCards.map((card) => (
          <MetricCard key={card.id} {...card} />
        ))}
      </div>

      <div className="mt-8 mb-4">
        <h2 className="text-xs font-bold text-zinc-500 uppercase tracking-widest mb-4 flex items-center gap-2">
          <Zap className="w-3 h-3" />
          Live Performance Benchmark
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
          {benchmarkCards.map((card) => (
            <MetricCard key={card.id} {...card} />
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="p-6 rounded-2xl bg-zinc-900/30 border border-zinc-800/50">
          <h3 className="text-sm font-semibold text-zinc-300 flex items-center gap-2 mb-6">
            <Box className="w-4 h-4 text-indigo-400" />
            RAG / AST Index
          </h3>
          <div className="space-y-4">
            <div className="flex justify-between items-center pb-4 border-b border-zinc-800/50">
              <span className="text-zinc-400 text-sm">Indexed Files</span>
              <span className="font-mono text-zinc-100 bg-zinc-800/50 px-2 py-1 rounded text-sm">{stats.files_indexed ?? 0}</span>
            </div>
            <div className="flex justify-between items-center pb-4 border-b border-zinc-800/50">
              <span className="text-zinc-400 text-sm">Index Size</span>
              <span className="font-mono text-zinc-100 bg-zinc-800/50 px-2 py-1 rounded text-sm">{formatBytes(stats.index_size_bytes ?? 0)}</span>
            </div>
          </div>
        </div>

        <div className="p-6 rounded-2xl bg-zinc-900/30 border border-zinc-800/50">
          <h3 className="text-sm font-semibold text-zinc-300 flex items-center gap-2 mb-6">
            <Server className="w-4 h-4 text-indigo-400" />
            Traffic Analytics
          </h3>
          <div className="space-y-4">
            <div className="flex justify-between items-center pb-4 border-b border-zinc-800/50">
              <span className="text-zinc-400 text-sm">Successful Requests</span>
              <span className="font-mono text-emerald-400 bg-emerald-400/10 px-2 py-1 rounded text-sm">{stats.requests_ok ?? 0}</span>
            </div>
            <div className="flex justify-between items-center pb-4 border-b border-zinc-800/50">
              <span className="text-zinc-400 text-sm">Failed Requests</span>
              <span className="font-mono text-rose-400 bg-rose-400/10 px-2 py-1 rounded text-sm">{stats.requests_error ?? 0}</span>
            </div>
            <div className="flex justify-between items-center pb-4 border-b border-zinc-800/50">
              <span className="text-zinc-400 text-sm">Aether Bypasses</span>
              <span className="font-mono text-amber-400 bg-amber-400/10 px-2 py-1 rounded text-sm">{stats.aether_bypass ?? 0}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

type HistoryRowProps = {
  request: Record<string, any>;
};

const HistoryRow = ({ request }: HistoryRowProps) => {
  const rawTokens = request.tokensRaw ?? request.tokensBefore ?? 0;
  const finalTokens = request.tokensAfter ?? request.tokensBefore ?? 0;
  const engineeredTokens = request.tokensBefore ?? 0;
  const ideRemoved = Math.max(0, rawTokens - engineeredTokens);
  const injectedTokens = request.tokensInjected ?? Math.max(0, finalTokens - engineeredTokens);
  const budgetCut = Math.max(0, engineeredTokens + injectedTokens - finalTokens);
  const totalPct = rawTokens > 0 ? Math.round(((rawTokens - finalTokens) / rawTokens) * 100) : 0;

  return (
    <tr className={`hover:bg-zinc-800/30 transition-colors ${request.ok ? '' : 'bg-rose-950/10'}`}>
      <td className="px-6 py-4 whitespace-nowrap text-xs">{new Date(request.ts).toLocaleTimeString()}</td>
      <td className="px-6 py-4">
        {request.ok ? (
          <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
            <CheckCircle className="w-3 h-3" /> OK
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium bg-rose-500/10 text-rose-400 border border-rose-500/20">
            <AlertTriangle className="w-3 h-3" /> FAILED
          </span>
        )}
      </td>
      <td className="px-6 py-4 font-mono text-zinc-300">{(((request.astTime ?? 0) + (request.ragTime ?? 0)) / 1000).toFixed(2)}s</td>
      <td className="px-6 py-4 font-mono">
        {request.rerankTime > 0 ? (
          <span className="text-purple-400 flex items-center gap-1">
            <Brain className="w-3 h-3" /> {request.rerankTime}ms
          </span>
        ) : (
          <span className="text-zinc-600">—</span>
        )}
      </td>
      <td className="px-6 py-4 font-mono">{((request.ttft ?? 0) / 1000).toFixed(2)}s</td>
      <td className="px-6 py-4 font-mono text-emerald-400">{request.tps ?? 0} <span className="text-[10px] text-zinc-500 uppercase">t/s</span></td>
      <td className="px-6 py-4 font-mono">{((request.latencyMs ?? 0) / 1000).toFixed(2)}s</td>
      <td className="px-6 py-4 font-mono text-xs">{finalTokens} <span className="text-zinc-500">tok</span></td>
      <td className="px-6 py-4 text-xs">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1 text-zinc-500">
            <span className="font-mono text-zinc-300">{rawTokens}</span>
            <span>→</span>
            <span className="font-mono text-emerald-400">{finalTokens}</span>
            {totalPct > 0 && <span className="text-amber-400 font-semibold">({totalPct}% saved)</span>}
          </div>
          {ideRemoved > 0 && <span className="text-rose-400/80 font-mono">IDE filter: -{ideRemoved}</span>}
          {injectedTokens > 0 && <span className="text-sky-400/80 font-mono">Aether inject: +{injectedTokens}</span>}
          {budgetCut > 0 && <span className="text-orange-400/80 font-mono">Budget trim: -{budgetCut}</span>}
        </div>
      </td>
    </tr>
  );
};

type HistoryTabContentProps = {
  stats: DashboardStats | null;
};

const HistoryTabContent = ({ stats }: HistoryTabContentProps) => {
  const history = stats?.history ?? [];

  if (!history.length) {
    return <DashboardEmptyState icon={List} message="No prompt history yet. Send a request in KiloCode!" />;
  }

  return (
    <div className="bg-zinc-900/40 border border-zinc-800/50 rounded-2xl overflow-hidden shadow-lg backdrop-blur-sm">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm text-zinc-400">
          <thead className="bg-zinc-950/80 border-b border-zinc-800/50 text-xs uppercase tracking-wider">
            <tr>
              <th className="px-6 py-4 font-medium">Time</th>
              <th className="px-6 py-4 font-medium">Status</th>
              <th className="px-6 py-4 font-medium">Context (AST+RAG)</th>
              <th className="px-6 py-4 font-medium">Rerank</th>
              <th className="px-6 py-4 font-medium">TTFT</th>
              <th className="px-6 py-4 font-medium">Gen Speed</th>
              <th className="px-6 py-4 font-medium">Total Latency</th>
              <th className="px-6 py-4 font-medium">Payload</th>
              <th className="px-6 py-4 font-medium">Tokens Saved</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/50">
            {history.map((request: Record<string, any>) => (
              <HistoryRow key={request.id} request={request} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

type IndexingTabContentProps = {
  stats: DashboardStats | null;
};

const IndexingTabContent = ({ stats }: IndexingTabContentProps) => {
  if (!stats) {
    return <DashboardEmptyState icon={Box} message="Waiting for indexing metrics..." />;
  }

  const queuePending = stats.queue_pending ?? 0;
  const queueLastSeen = stats.queue_last_sec ?? 0;
  const filesIndexed = stats.files_indexed ?? 0;
  const indexSizeBytes = stats.index_size_bytes ?? 0;
  const stateLabel = getIndexingStateLabel(queuePending, filesIndexed);
  const stateTone = getIndexingStateTone(queuePending, filesIndexed);

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="p-6 rounded-2xl bg-zinc-900/40 border border-zinc-800/50 shadow-lg backdrop-blur-sm">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-widest text-zinc-500 font-semibold mb-2">Index status</p>
            <h2 className={`text-2xl font-semibold ${stateTone}`}>{stateLabel}</h2>
            <p className="text-sm text-zinc-400 mt-2 max-w-2xl">
              This view summarizes the local AST/RAG index used by the context engine. It stays lightweight and only uses the stats already exposed by the gateway.
            </p>
          </div>
          <div className="px-4 py-2 rounded-full bg-zinc-950/70 border border-zinc-800/50 text-xs uppercase tracking-widest text-zinc-500 font-semibold">
            {queuePending > 0 ? `${queuePending} pending jobs` : 'No pending jobs'}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          title="Indexed Files"
          icon={Box}
          value={filesIndexed}
          valueClassName="text-3xl font-bold tracking-tight text-zinc-100"
          glowClassName="bg-indigo-500/5 group-hover:bg-indigo-500/10"
          iconClassName="text-indigo-400"
          note={filesIndexed > 0 ? 'Files currently in the AST/RAG index' : 'No files indexed yet'}
        />
        <MetricCard
          title="Index Size"
          icon={Database}
          value={formatBytes(indexSizeBytes)}
          valueClassName="text-3xl font-bold tracking-tight text-zinc-100"
          glowClassName="bg-emerald-500/5 group-hover:bg-emerald-500/10"
          iconClassName="text-emerald-400"
          note="On-disk SQLite + LanceDB footprint"
        />
        <MetricCard
          title="Queue Pending"
          icon={RefreshCw}
          value={queuePending}
          valueClassName={`text-3xl font-bold tracking-tight ${queuePending > 0 ? 'text-amber-400' : 'text-zinc-100'}`}
          glowClassName="bg-amber-500/5 group-hover:bg-amber-500/10"
          iconClassName="text-amber-400"
          note={queuePending > 0 ? 'Indexing work is still queued' : 'No pending indexing jobs'}
        />
        <MetricCard
          title="Last Activity"
          icon={Clock}
          value={queueLastSeen > 0 ? `${formatUptime(queueLastSeen)} ago` : 'now'}
          valueClassName="text-3xl font-bold tracking-tight text-zinc-100"
          glowClassName="bg-purple-500/5 group-hover:bg-purple-500/10"
          iconClassName="text-purple-400"
          note="Time since the last gateway request"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="p-6 rounded-2xl bg-zinc-900/30 border border-zinc-800/50">
          <h3 className="text-sm font-semibold text-zinc-300 flex items-center gap-2 mb-6">
            <Zap className="w-4 h-4 text-indigo-400" />
            Index Pipeline
          </h3>
          <div className="space-y-4">
            <div className="flex justify-between items-center pb-4 border-b border-zinc-800/50">
              <span className="text-zinc-400 text-sm">Queue status</span>
              <span className={`font-mono ${queuePending > 0 ? 'text-amber-400' : 'text-emerald-400'}`}>{queuePending > 0 ? 'Busy' : 'Idle'}</span>
            </div>
            <div className="flex justify-between items-center pb-4 border-b border-zinc-800/50">
              <span className="text-zinc-400 text-sm">Index freshness</span>
              <span className="font-mono text-zinc-100">{queueLastSeen > 0 ? `${formatUptime(queueLastSeen)} since activity` : 'Live'}</span>
            </div>
            <div className="flex justify-between items-center pb-4 border-b border-zinc-800/50">
              <span className="text-zinc-400 text-sm">AST/RAG footprint</span>
              <span className="font-mono text-zinc-100">{filesIndexed > 0 ? `${filesIndexed} files` : 'Empty'}</span>
            </div>
          </div>
        </div>

        <div className="p-6 rounded-2xl bg-zinc-900/30 border border-zinc-800/50">
          <h3 className="text-sm font-semibold text-zinc-300 flex items-center gap-2 mb-6">
            <Server className="w-4 h-4 text-indigo-400" />
            Operational Notes
          </h3>
          <div className="space-y-4 text-sm text-zinc-400 leading-relaxed">
            <p>
              The indexing state is derived from the gateway stats, so it does not add extra polling or background work.
            </p>
            <p>
              If pending jobs stay above zero for long periods, the daemon is likely still re-scanning files or the project tree is growing faster than the background loop finishes.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

type LogsTabContentProps = {
  logs: string[];
  engineStatus: DashboardEngineStatus;
  logsEndRef: React.RefObject<HTMLDivElement | null>;
};

const LogsTabContent = ({ logs, engineStatus, logsEndRef }: LogsTabContentProps) => {
  const [activeCategory, setActiveCategory] = useState<DashboardLogCategory>('all');

  const categorizedLogs = logs.map((log, index) => ({
    id: `${index}-${log}`,
    text: log,
    category: getLogCategory(log),
  }));

  const categoryCounts = categorizedLogs.reduce<Record<DashboardLogCategory, number>>((accumulator, entry) => {
    accumulator.all += 1;
    accumulator[entry.category] += 1;
    return accumulator;
  }, {
    all: 0,
    startup: 0,
    index: 0,
    rerank: 0,
    core: 0,
    mlx: 0,
    gateway: 0,
    error: 0,
  });

  const filteredLogs = activeCategory === 'all'
    ? categorizedLogs
    : categorizedLogs.filter((entry) => entry.category === activeCategory);

  return (
    <div className="h-[calc(100vh-140px)] animate-in fade-in slide-in-from-bottom-4 duration-500 flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {LOG_CATEGORY_ORDER.map((category) => {
          const isActive = activeCategory === category;
          return (
            <button
              key={category}
              type="button"
              onClick={() => setActiveCategory(category)}
              className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition-all ${isActive ? 'border-indigo-400/30 bg-indigo-500/10 text-indigo-200' : 'border-zinc-800/70 bg-zinc-900/40 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200'}`}
            >
              <span>{LOG_CATEGORY_LABELS[category]}</span>
              <span className={`rounded-full px-1.5 py-0.5 font-mono text-[10px] ${isActive ? 'bg-indigo-400/15 text-indigo-200' : 'bg-zinc-800/80 text-zinc-400'}`}>
                {categoryCounts[category]}
              </span>
            </button>
          );
        })}
      </div>

      <div className="bg-zinc-950 border border-zinc-800/50 rounded-2xl flex-1 overflow-hidden flex flex-col shadow-lg backdrop-blur-sm">
        <div className="bg-zinc-900/80 px-4 py-3 border-b border-zinc-800/50 flex items-center gap-2">
          <Terminal className="w-4 h-4 text-zinc-500" />
          <span className="text-sm font-mono text-zinc-400">aether-engine.log</span>
          <span className="ml-2 rounded-full border border-zinc-800/70 bg-zinc-950/80 px-2 py-0.5 text-[10px] uppercase tracking-widest text-zinc-500">
            {LOG_CATEGORY_LABELS[activeCategory]}
          </span>
          {engineStatus === 'running' && (
            <span className="ml-auto flex h-2 w-2 relative">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
            </span>
          )}
        </div>
        <div className="flex-1 overflow-y-auto p-4 font-mono text-xs leading-relaxed text-zinc-300">
          {filteredLogs.length === 0 ? (
            <div className="h-full flex items-center justify-center text-zinc-600">
              {activeCategory === 'all' ? 'Waiting for engine logs...' : `No ${LOG_CATEGORY_LABELS[activeCategory].toLowerCase()} logs yet.`}
            </div>
          ) : (
            <div className="space-y-1">
              {filteredLogs.map((entry, index) => (
                <div key={entry.id} className={`whitespace-pre-wrap break-all ${getLogClassName(entry.text)}`}>
                  <span className="text-zinc-600 select-none mr-3">{String(index + 1).padStart(3, '0')}</span>
                  {entry.text}
                </div>
              ))}
              <div ref={logsEndRef} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

type ConfigTabContentProps = {
  config: DashboardConfig;
  setConfig: React.Dispatch<React.SetStateAction<DashboardConfig>>;
  isSaving: boolean;
  onPickFolder: () => void;
  onSaveConfig: (event: React.SubmitEvent<HTMLFormElement>) => void;
};

const ConfigTabContent = ({ config, setConfig, isSaving, onPickFolder, onSaveConfig }: ConfigTabContentProps) => (
  <div className="max-w-2xl animate-in fade-in slide-in-from-bottom-4 duration-500">
    <div className="p-6 rounded-2xl bg-zinc-900/40 border border-zinc-800/50 shadow-lg backdrop-blur-sm relative overflow-hidden">
      <div className="absolute top-0 right-0 w-64 h-64 bg-indigo-500/5 rounded-full blur-3xl -mr-20 -mt-20" />

      <h2 className="text-lg font-semibold text-zinc-100 mb-6 flex items-center gap-2">
        <Settings className="w-5 h-5 text-indigo-400" />
        Daemon Settings
      </h2>

      <form onSubmit={onSaveConfig} className="space-y-6 relative">
        <div className="space-y-2">
          <label htmlFor="mlx-model-path" className="text-sm font-medium text-zinc-300 ml-1">MLX Model Path</label>
          <p className="text-xs text-zinc-500 ml-1 mb-2">Absolute path to your local MLX weights or HuggingFace repo ID.</p>
          <div className="flex gap-2">
            <input
              id="mlx-model-path"
              type="text"
              value={config.modelPath}
              onChange={(event) => setConfig((current) => ({ ...current, modelPath: event.target.value }))}
              className="flex-1 bg-zinc-950/50 border border-zinc-800 rounded-lg px-4 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all"
              placeholder="/Users/name/models/Qwen3.6-..."
            />
            <button
              type="button"
              onClick={onPickFolder}
              className="px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-300 hover:bg-zinc-700 hover:text-white transition-colors flex items-center gap-2 text-sm shadow-sm"
              title="Browse folders"
            >
              <FolderOpen className="w-4 h-4" />
              Browse
            </button>
          </div>
        </div>

        <div className="space-y-2">
          <label htmlFor="token-budget" className="text-sm font-medium text-zinc-300 ml-1">Token Budget</label>
          <p className="text-xs text-zinc-500 ml-1 mb-2">Maximum tokens allowed in the context window. Lower = faster, Higher = smarter.</p>
          <input
            id="token-budget"
            type="number"
            value={config.tokenBudget}
            onChange={(event) => setConfig((current) => ({ ...current, tokenBudget: Number.parseInt(event.target.value) || 16384 }))}
            className="w-full bg-zinc-950/50 border border-zinc-800 rounded-lg px-4 py-2.5 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all"
            min="1024"
            max="32768"
            step="1024"
          />
        </div>

        <div className="pt-4 mt-6 border-t border-zinc-800/50 flex items-center justify-end">
          <button
            type="submit"
            disabled={isSaving}
            className="bg-indigo-500 hover:bg-indigo-400 text-white px-5 py-2.5 rounded-lg text-sm font-medium shadow-[inset_0_1px_0_0_rgba(255,255,255,0.1)] transition-colors flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSaving ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            Save Configuration
          </button>
        </div>
      </form>
    </div>

    <div className="mt-6 p-4 rounded-xl bg-amber-500/5 border border-amber-500/20 text-amber-200/80 text-sm flex gap-3 leading-relaxed">
      <span className="text-amber-500 text-lg">💡</span>
      <p>Changing the model path requires a full restart of the MLX Inference Server. After saving, please run <code className="bg-amber-500/20 px-1.5 py-0.5 rounded text-amber-400">aether restart</code> in your terminal.</p>
    </div>
  </div>
);

type DashboardTabContentProps = {
  activeTab: DashboardTab;
  stats: DashboardStats | null;
  bench: DashboardBenchmarkStats;
  config: DashboardConfig;
  setConfig: React.Dispatch<React.SetStateAction<DashboardConfig>>;
  isSaving: boolean;
  engineStatus: DashboardEngineStatus;
  logs: string[];
  liveTtft: number;
  liveTotalTime: number;
  onPickFolder: () => void;
  onSaveConfig: (event: React.SubmitEvent<HTMLFormElement>) => void;
  logsEndRef: React.RefObject<HTMLDivElement | null>;
};

const DashboardTabContent = ({
  activeTab,
  stats,
  bench,
  config,
  setConfig,
  isSaving,
  engineStatus,
  logs,
  liveTtft,
  liveTotalTime,
  onPickFolder,
  onSaveConfig,
  logsEndRef,
}: DashboardTabContentProps) => {
  switch (activeTab) {
    case 'metrics':
      return stats ? (
        <MetricsTabContent stats={stats} bench={bench} liveTtft={liveTtft} liveTotalTime={liveTotalTime} />
      ) : (
        <DashboardEmptyState icon={Activity} message="Waiting for data..." />
      );
    case 'history':
      return <HistoryTabContent stats={stats} />;
    case 'indexing':
      return <IndexingTabContent stats={stats} />;
    case 'logs':
      return <LogsTabContent logs={logs} engineStatus={engineStatus} logsEndRef={logsEndRef} />;
    case 'config':
    default:
      return <ConfigTabContent config={config} setConfig={setConfig} isSaving={isSaving} onPickFolder={onPickFolder} onSaveConfig={onSaveConfig} />;
  }
};

type DashboardViewProps = Readonly<{
  activeTab: DashboardTab;
  setActiveTab: (tab: DashboardTab) => void;
  stats: DashboardStats | null;
  bench: DashboardBenchmarkStats;
  config: DashboardConfig;
  setConfig: React.Dispatch<React.SetStateAction<DashboardConfig>>;
  isSaving: boolean;
  engineStatus: DashboardEngineStatus;
  logs: string[];
  toasts: Toast[];
  services: DashboardServices;
  liveTtft: number;
  liveTotalTime: number;
  onDismissToast: (id: number) => void;
  onToggleEngine: () => void;
  onPickFolder: () => void;
  onSaveConfig: (event: React.SubmitEvent<HTMLFormElement>) => void;
}>;

export default function DashboardView({
  activeTab,
  setActiveTab,
  stats,
  bench,
  config,
  setConfig,
  isSaving,
  engineStatus,
  logs,
  toasts,
  services,
  liveTtft,
  liveTotalTime,
  onDismissToast,
  onToggleEngine,
  onPickFolder,
  onSaveConfig,
}: DashboardViewProps) {
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const hasStats = stats !== null;
  const showGatewayOffline = services.gateway === 'offline';
  const showLiveBadge = hasStats && activeTab === 'metrics';

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-50 flex font-sans selection:bg-indigo-500/30">
      <ToastStack toasts={toasts} onDismissToast={onDismissToast} />
      <Sidebar activeTab={activeTab} setActiveTab={setActiveTab} services={services} engineStatus={engineStatus} onToggleEngine={onToggleEngine} />

      <main className="flex-1 overflow-auto bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-zinc-900/40 via-zinc-950 to-zinc-950">
        <header className="h-16 flex items-center justify-between px-8 border-b border-zinc-800/30">
          <h1 className="text-xl font-semibold text-zinc-100">{getHeaderTitle(activeTab)}</h1>
          <LiveUpdatesBadge visible={showLiveBadge} />
        </header>

        <div className="p-8 max-w-6xl mx-auto">
          <GatewayOfflineBanner visible={showGatewayOffline} />
          <DashboardTabContent
            activeTab={activeTab}
            stats={stats}
            bench={bench}
            config={config}
            setConfig={setConfig}
            isSaving={isSaving}
            engineStatus={engineStatus}
            logs={logs}
            liveTtft={liveTtft}
            liveTotalTime={liveTotalTime}
            onPickFolder={onPickFolder}
            onSaveConfig={onSaveConfig}
            logsEndRef={logsEndRef}
          />
        </div>
      </main>
    </div>
  );
}
