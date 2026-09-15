// Funções puras de transição do mapa de máquinas conectadas — extraídas do
// App.jsx para serem testáveis isoladamente (ver __tests__/connectionState.test.js).
// Nunca mutam o mapa recebido; sempre devolvem uma cópia (ou o mesmo objeto
// quando não há nada a mudar, ex.: disconnectMachineEntry com id desconhecido).

export function connectMachineEntry(connectedMachines, machine, extra = {}) {
  return {
    ...connectedMachines,
    [machine.id]: { machine, ftSessionId: null, ...extra },
  };
}

export function disconnectMachineEntry(connectedMachines, id) {
  if (!(id in connectedMachines)) return connectedMachines;
  const next = { ...connectedMachines };
  delete next[id];
  return next;
}

// Decide o próximo foco quando a máquina removida era a focada: cai para
// outra máquina ainda conectada (ordem arbitrária) ou null se não sobrou
// nenhuma. Se a removida não era a focada, o foco atual não muda.
export function pickFocusAfterDisconnect(connectedMachines, focusedId, removedId) {
  if (focusedId !== removedId) return focusedId;
  const remaining = Object.keys(connectedMachines).filter((id) => id !== removedId);
  return remaining.length > 0 ? remaining[0] : null;
}
