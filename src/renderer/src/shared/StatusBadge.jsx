export default function StatusBadge({ state }) {
  const colors = {
    connected: 'bg-success',
    connecting: 'bg-warning animate-pulse',
    credentials: 'bg-warning animate-pulse',
    disconnected: 'bg-text-faint',
    error: 'bg-danger',
  };

  const labels = {
    connected: 'Conectado',
    connecting: 'Conectando...',
    credentials: 'Senha necessária',
    disconnected: 'Desconectado',
    error: 'Erro',
  };

  const color = colors[state] || colors.disconnected;
  const label = labels[state] || 'Offline';

  return (
    <div className="flex items-center gap-2">
      <div className={`w-2.5 h-2.5 rounded-full ${color}`} />
      <span className="text-xs text-text-muted">{label}</span>
    </div>
  );
}
