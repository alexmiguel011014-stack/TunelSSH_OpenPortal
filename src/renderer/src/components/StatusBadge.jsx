export default function StatusBadge({ state }) {
  const colors = {
    connected: 'bg-emerald-500',
    connecting: 'bg-amber-500 animate-pulse',
    credentials: 'bg-amber-500 animate-pulse',
    disconnected: 'bg-slate-600',
    error: 'bg-red-500',
  };

  const labels = {
    connected: 'Connected',
    connecting: 'Connecting...',
    credentials: 'Password required',
    disconnected: 'Disconnected',
    error: 'Error',
  };

  const color = colors[state] || colors.disconnected;
  const label = labels[state] || 'Offline';

  return (
    <div className="flex items-center gap-2">
      <div className={`w-2.5 h-2.5 rounded-full ${color}`} />
      <span className="text-xs text-slate-400">{label}</span>
    </div>
  );
}
