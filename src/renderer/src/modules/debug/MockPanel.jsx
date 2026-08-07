import { useState, useEffect, useContext } from 'react';
import { MachineContext } from '../../App';

export default function MockPanel() {
  const { addLog } = useContext(MachineContext);
  const [mockActive, setMockActive] = useState(false);
  const [mockMode, setMockMode] = useState('approve');

  useEffect(() => {
    // Verificar se mock server está ativo
    window.electronAPI?.mockGetStatus?.().then((status) => {
      setMockActive(status.active);
      if (status.active) {
        setMockMode(status.mode);
      }
    }).catch(() => {});
  }, []);

  const handleSetMode = async (mode) => {
    try {
      const res = await window.electronAPI?.mockSetMode?.(mode);
      if (res?.success) {
        setMockMode(mode);
        addLog(`Mock mode: ${mode}`, 'info');
      } else {
        addLog(`Erro: ${res?.message || 'Desconhecido'}`, 'error');
      }
    } catch (err) {
      addLog(`Erro ao mudar mock mode: ${err.message}`, 'error');
    }
  };

  if (!mockActive) {
    return (
      <div className="p-4 bg-blue-900/20 border border-blue-700/50 rounded-lg">
        <p className="text-xs text-blue-400">
          💡 Mock Server desativo. Para ativar em testes locais:
        </p>
        <pre className="text-xs text-blue-300 mt-2 p-2 bg-blue-950/50 rounded">
          OPENPORTAL_MOCK=true npm run dev
        </pre>
      </div>
    );
  }

  return (
    <div className="p-4 bg-purple-900/20 border border-purple-700/50 rounded-lg">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 bg-purple-400 rounded-full animate-pulse" />
          <h3 className="text-sm font-semibold text-purple-300">Mock Server Ativo</h3>
        </div>
        <span className="text-xs px-2 py-1 bg-purple-700/50 text-purple-200 rounded">
          Porta 18903
        </span>
      </div>

      <p className="text-xs text-purple-300 mb-4">
        Simula um PC remoto respondendo a conexões. Útil para testar diálogos de aprovação/rejeição.
      </p>

      <div className="space-y-2">
        <button
          onClick={() => handleSetMode('approve')}
          className={`w-full px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            mockMode === 'approve'
              ? 'bg-green-600 text-white'
              : 'bg-green-900/30 text-green-300 hover:bg-green-900/50 border border-green-700/50'
          }`}
        >
          ✓ Sempre Aprovar
        </button>

        <button
          onClick={() => handleSetMode('reject')}
          className={`w-full px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            mockMode === 'reject'
              ? 'bg-red-600 text-white'
              : 'bg-red-900/30 text-red-300 hover:bg-red-900/50 border border-red-700/50'
          }`}
        >
          ✗ Sempre Rejeitar
        </button>

        <button
          onClick={() => handleSetMode('toggle')}
          className={`w-full px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            mockMode === 'toggle'
              ? 'bg-yellow-600 text-white'
              : 'bg-yellow-900/30 text-yellow-300 hover:bg-yellow-900/50 border border-yellow-700/50'
          }`}
        >
          ⇄ Alternar (Cada conexão muda)
        </button>
      </div>

      <p className="text-xs text-purple-400 mt-3">
        💻 Conecte em: <code className="bg-purple-950/50 px-1 rounded">127.0.0.1</code> (localhost)
      </p>
    </div>
  );
}
