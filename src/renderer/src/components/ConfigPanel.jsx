import { useContext, useState } from 'react';
import { MachineContext } from '../App';

export default function ConfigPanel() {
  const { machines, saveMachines, addMachine, removeMachine, setShowConfig, maxMachines, addLog } = useContext(MachineContext);

  const [draft, setDraft] = useState(() => machines.map((m) => ({ ...m })));
  const [saved, setSaved] = useState(false);

  const updateField = (index, field, value) => {
    setDraft((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value };
      return next;
    });
    setSaved(false);
  };

  const handleSave = () => {
    saveMachines(draft);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleAddLocal = () => {
    if (draft.length >= maxMachines) {
      if (addLog) addLog(`Max ${maxMachines} machines reached`, 'warn');
      return;
    }
    const newMachine = { id: 'tmp-' + Date.now(), name: `PC ${draft.length + 1}`, host: '', port: 5900 };
    setDraft(prev => [...prev, newMachine]);
  };

  const handleRemoveLocal = (index) => {
    if (draft.length <= 1) return;
    setDraft(prev => prev.filter((_, i) => i !== index));
  };

  return (
    <div className="flex-1 overflow-y-auto p-8">
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h2 className="text-2xl font-semibold text-slate-100">Settings</h2>
            <p className="text-sm text-slate-400 mt-1">
              Configure your remote machines ({draft.length}/{maxMachines})
            </p>
          </div>
          <button
            onClick={() => setShowConfig(false)}
            className="px-4 py-2 text-sm text-slate-400 hover:text-white transition-colors"
          >
            ← Back
          </button>
        </div>

        <div className="space-y-4">
          {draft.map((machine, index) => (
            <div
              key={machine.id}
              className="bg-slate-800 rounded-xl p-5 border border-slate-700 relative"
            >
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-medium text-slate-300">{machine.name || `PC ${index + 1}`}</h3>
                {draft.length > 1 && (
                  <button
                    onClick={() => handleRemoveLocal(index)}
                    className="text-xs text-red-400 hover:text-red-300 transition-colors bg-transparent border border-red-800/50 rounded px-2 py-1"
                  >
                    Remove
                  </button>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs text-slate-500 mb-1">Name</label>
                  <input
                    type="text"
                    value={machine.name}
                    onChange={(e) => updateField(index, 'name', e.target.value)}
                    className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-blue-500 transition-colors"
                    placeholder="Office PC"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">Tailscale IP</label>
                  <input
                    type="text"
                    value={machine.host}
                    onChange={(e) => updateField(index, 'host', e.target.value)}
                    className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-100 font-mono focus:outline-none focus:border-blue-500 transition-colors"
                    placeholder="100.x.x.x"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">VNC Port</label>
                  <input
                    type="number"
                    value={machine.port}
                    onChange={(e) => updateField(index, 'port', parseInt(e.target.value) || 5900)}
                    className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-100 font-mono focus:outline-none focus:border-blue-500 transition-colors"
                    placeholder="5900"
                  />
                </div>
              </div>
            </div>
          ))}
        </div>

        {draft.length < maxMachines && (
          <button
            onClick={handleAddLocal}
            className="w-full mt-4 p-3 rounded-xl border-2 border-dashed border-slate-700 text-slate-400 text-sm hover:border-slate-500 hover:text-slate-300 transition-colors bg-transparent cursor-pointer"
          >
            + Add Machine
          </button>
        )}

        <div className="mt-8 flex items-center gap-4">
          <button
            onClick={handleSave}
            className="px-6 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium transition-colors"
          >
            {saved ? '✓ Saved' : 'Save Configuration'}
          </button>
          {saved && (
            <span className="text-sm text-emerald-400">Configuration saved</span>
          )}
        </div>

        <div className="mt-6 p-4 bg-slate-800/50 rounded-lg border border-slate-700/50">
          <p className="text-xs text-slate-500">
            Enter the Tailscale IP address of each remote PC. TightVNC Server
            must be running on port 5900 (or the port you specify). Max {maxMachines} machines.
          </p>
        </div>
      </div>
    </div>
  );
}
