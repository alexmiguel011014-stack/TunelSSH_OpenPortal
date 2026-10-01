// Regras de apresentação do modo laboratório (GOALS 16), sem React: os rótulos
// de estado, quando "Abrir tela" vale e como mostrar o resultado de adicionar um
// PC. Os estados vêm do main (lab/manager.js).

export const LAB_STATE_LABELS = {
  free: 'Livre',
  reserved: 'Reservado',
  'in-use': 'Em uso',
  offline: 'Offline',
  incompatible: 'Incompatível',
  refused: 'Sem acesso',
  checking: 'Consultando...',
};

const LAB_STATE_TONES = {
  free: 'success',
  reserved: 'warning',
  'in-use': 'accent',
  offline: 'faint',
  incompatible: 'warning',
  refused: 'danger',
  checking: 'faint',
};

export function labStateLabel(state) {
  return LAB_STATE_LABELS[state] || LAB_STATE_LABELS.checking;
}

export function labStateTone(state) {
  return LAB_STATE_TONES[state] || 'faint';
}

// "Abrir tela" só enquanto o PC responde e não há aluno na sessão: com um aluno
// conectado por RDP, o RDP do gerente o desconectaria e o VNC mostraria só a
// sessão trancada do dono (por isso o PC em uso oferece "Ver pasta").
export function canOpenLabScreen(state) {
  return state === 'free' || state === 'reserved';
}

export function labOpenHint(state) {
  if (canOpenLabScreen(state)) return 'Abre a tela deste PC sem pedir permissão';
  if (state === 'in-use') return 'Há um aluno usando este PC';
  if (state === 'offline') return 'Este PC não está respondendo';
  if (state === 'incompatible') return 'Versão do modo laboratório diferente da deste app';
  if (state === 'refused') return 'Este PC não reconhece mais você como gerente';
  return 'Consultando este PC';
}

// O modo laboratório vale neste PC quando a tela foi ligada em Configurações ou
// quando ele já é gerenciado por alguém.
export function isLabModeOn(labHost) {
  return Boolean(labHost && (labHost.mode || labHost.managed));
}

export function summarizeRoster(roster) {
  const summary = {
    total: 0,
    free: 0,
    reserved: 0,
    inUse: 0,
    offline: 0,
    other: 0,
  };
  for (const entry of Array.isArray(roster) ? roster : []) {
    summary.total += 1;
    if (entry.state === 'free') summary.free += 1;
    else if (entry.state === 'reserved') summary.reserved += 1;
    else if (entry.state === 'in-use') summary.inUse += 1;
    else if (entry.state === 'offline') summary.offline += 1;
    else summary.other += 1;
  }
  return summary;
}

// Texto curto para a linha de ajuda sob a lista de PCs.
export function describeRosterSummary(roster) {
  const { total, free, reserved, inUse, offline } = summarizeRoster(roster);
  if (total === 0) return 'Nenhum PC na lista';
  const parts = [`${total} PC${total === 1 ? '' : 's'}`];
  if (free) parts.push(`${free} livre${free === 1 ? '' : 's'}`);
  if (reserved) parts.push(`${reserved} reservado${reserved === 1 ? '' : 's'}`);
  if (inUse) parts.push(`${inUse} em uso`);
  if (offline) parts.push(`${offline} offline`);
  return parts.join(' · ');
}

// Resultado de `lab:add` para mostrar sob o campo de IP.
export function describeAddResult(result) {
  if (result?.ok) {
    const name = result.entry?.name || 'PC';
    return { kind: 'info', text: `${name} adicionado à lista` };
  }
  return {
    kind: 'error',
    text: result?.message || 'Não foi possível adicionar o PC',
  };
}

// Estado do serviço do laboratório neste PC (Configurações → Modo laboratório).
export function describeServiceState(state) {
  if (!state) return 'Consultando...';
  if (!state.installed) return 'Não habilitado neste PC';
  if (!state.running) return 'Instalado, mas parado';
  if (!state.reachable) return 'Rodando, mas não respondeu';
  const count = state.studentCount || 0;
  const students = count === 1 ? '1 aluno' : `${count} alunos`;
  const quota = state.quota === 'off' ? ' · cota de disco desligada' : '';
  const rdp = state.rdpHosting === false ? ' · Remote Desktop desligado' : '';
  return `Funcionando · ${students}${quota}${rdp}`;
}

// Lista de gerentes para o cartão "Este PC é gerenciado".
export function describeManagers(managers) {
  const list = Array.isArray(managers) ? managers : [];
  if (list.length === 0) return 'Ninguém gerencia este PC';
  return list.length === 1 ? '1 gerente' : `${list.length} gerentes`;
}
