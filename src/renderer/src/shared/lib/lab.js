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

// ---- GOALS 18: alunos, reserva e credenciais ----------------------------------------

export const DEFAULT_QUOTA_GB = 25;
export const MAX_QUOTA_GB = 2000;
// Validade da sessão, em minutos: as escolhas rápidas e o intervalo que o PC aceita.
export const VALIDITY_CHOICES = [30, 60, 120];
export const DEFAULT_VALIDITY_MIN = 60;
export const MIN_VALIDITY_MIN = 5;
export const MAX_VALIDITY_MIN = 12 * 60;
// Prazo para o aluno entrar (minutos) e o intervalo que o PC aceita.
export const DEFAULT_START_WITHIN_MIN = 30;
export const MIN_START_WITHIN_MIN = 1;
export const MAX_START_WITHIN_MIN = 24 * 60;
// Quanto a sessão pode ser estendida de uma vez.
export const EXTEND_CHOICES = [15, 30, 60];

export const DEFAULT_CREDENTIAL_NOTICE = 'O professor pode ver a sua pasta pessoal neste PC.';
export const SESSION_END_HINT =
  'Se, depois do horário de término, o Windows mostrar "erro de autenticação" (a senha pode ter expirado), é porque o acesso terminou.';
const NOTICE_STORAGE_KEY = 'openportal-lab-notice';
const MAX_NOTICE_LENGTH = 300;

const STUDENT_STATE_LABELS = {
  free: 'Livre',
  reserved: 'Reservado',
  'in-use': 'Em uso',
  ending: 'Encerrando',
};

export function studentStateLabel(state) {
  return STUDENT_STATE_LABELS[state] || STUDENT_STATE_LABELS.free;
}

export function studentStateTone(state) {
  if (state === 'reserved') return 'warning';
  if (state === 'in-use') return 'accent';
  if (state === 'ending') return 'danger';
  return 'success';
}

// "4,2 GB" (vírgula decimal). Valores muito pequenos não viram "0".
export function formatGb(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—';
  if (value === 0) return '0 GB';
  if (value < 0.1) return 'menos de 0,1 GB';
  const rounded = Math.round(value * 10) / 10;
  return `${String(rounded).replace('.', ',')} GB`;
}

// Quanto da cota o aluno usa, de 0 a 100 (para a barra).
export function usedPercent(student) {
  const quota = Number(student?.quotaGb);
  const used = Number(student?.usedGb);
  if (!(quota > 0) || !(used > 0)) return 0;
  return Math.min(100, Math.round((used / quota) * 100));
}

export function usageTone(percent) {
  if (percent >= 100) return 'danger';
  if (percent >= 90) return 'warning';
  return 'accent';
}

// A caixa de capacidade do disco: quantos alunos cabem e se as cotas somadas passam do
// que está livre. É um aviso, nunca um bloqueio (o professor decide).
export function describeCapacity(capacity, quotaState) {
  if (!capacity) {
    return { tone: 'faint', title: 'Capacidade do disco indisponível', lines: [] };
  }
  const { recommended, quotaGb, assignedGb, freeGb, totalGb, reserveGb, status } = capacity;
  const cabem = recommended === 1 ? 'Cabe 1 aluno' : `Cabem ${recommended} alunos`;
  const lines = [
    `Livre: ${formatGb(freeGb)} de ${formatGb(totalGb)} · reserva do sistema: ${formatGb(reserveGb)}`,
    `Cotas somadas: ${formatGb(assignedGb)}`,
  ];
  if (quotaState && quotaState !== 'enforce') {
    lines.push(
      quotaState === 'off'
        ? 'A cota de disco está desligada neste PC: os limites não são aplicados.'
        : 'A cota de disco só conta o uso, não impede de passar do limite.',
    );
  }
  if (status === 'over') {
    return {
      tone: 'danger',
      title: `${cabem} de ${formatGb(quotaGb)}, e as cotas somadas passam do espaço livre`,
      lines,
    };
  }
  if (status === 'tight') {
    return {
      tone: 'warning',
      title: `${cabem} de ${formatGb(quotaGb)}; não sobra espaço para mais um`,
      lines,
    };
  }
  return { tone: 'success', title: `${cabem} de ${formatGb(quotaGb)}`, lines };
}

const timeFormat = (timeZone) =>
  new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone });
const dayFormat = (timeZone) =>
  new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', timeZone });
const dayKey = (ms, timeZone) =>
  new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date(ms));

// Hora local "14:30".
export function formatClock(ms, timeZone) {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  return timeFormat(timeZone).format(new Date(ms));
}

export function formatMinutes(minutes) {
  if (!Number.isFinite(minutes) || minutes < 0) return '—';
  const whole = Math.round(minutes);
  if (whole < 60) return `${whole} min`;
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

export function timeLeftText(endsAt, now = Date.now()) {
  if (!Number.isFinite(endsAt) || endsAt <= 0) return '';
  const left = endsAt - now;
  if (left <= 0) return 'terminando';
  return `faltam ${formatMinutes(Math.ceil(left / 60000))}`;
}

// "nunca usou", "hoje às 14:30", "ontem às 09:10" ou "28/09 às 14:30".
export function lastSessionText(ts, now = Date.now(), timeZone) {
  if (!Number.isFinite(ts) || ts <= 0) return 'nunca usou';
  const at = formatClock(ts, timeZone);
  if (dayKey(ts, timeZone) === dayKey(now, timeZone)) return `hoje às ${at}`;
  if (dayKey(ts, timeZone) === dayKey(now - 24 * 3600 * 1000, timeZone)) return `ontem às ${at}`;
  return `${dayFormat(timeZone).format(new Date(ts))} às ${at}`;
}

// Texto que o professor copia para entregar o acesso ao aluno. O horário "até" da
// sessão é o MÁXIMO: o relógio da sessão só começa na primeira entrada.
export function buildCredentialMessage({
  pcName,
  host,
  userName,
  password,
  startBy,
  endsAt,
  sessionMinutes,
  notice,
  timeZone,
}) {
  const lines = [
    'Acesso ao PC do laboratório',
    `PC: ${pcName}${host ? ` (${host})` : ''}`,
    `Usuário: ${userName}`,
    `Senha: ${password}`,
    `Entre pela Conexão de Área de Trabalho Remota do Windows até as ${formatClock(startBy, timeZone)}.`,
  ];
  if (Number.isFinite(sessionMinutes) && sessionMinutes > 0) {
    lines.push(
      `A sessão dura ${formatMinutes(sessionMinutes)} a partir da entrada e termina, no máximo, às ${formatClock(endsAt, timeZone)}.`,
    );
  } else {
    lines.push(`A sessão termina, no máximo, às ${formatClock(endsAt, timeZone)}.`);
  }
  const cleanNotice = sanitizeNotice(notice);
  if (cleanNotice) lines.push(cleanNotice);
  lines.push(SESSION_END_HINT);
  return lines.join('\n');
}

// Controles de texto, menos tabulação e quebra de linha (o aviso pode ter várias linhas).
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const CONTROL_CHARS = new RegExp(CONTROL_CHARS_PATTERN.source, 'g');

export function sanitizeNotice(text) {
  if (typeof text !== 'string') return '';
  return text.replace(CONTROL_CHARS, ' ').trim().slice(0, MAX_NOTICE_LENGTH);
}

// O aviso editável fica neste PC (localStorage): é só o texto da instituição, nunca
// uma credencial. A senha do aluno não passa por aqui.
export function loadNotice(storage) {
  try {
    const saved = storage?.getItem(NOTICE_STORAGE_KEY);
    return saved === null || saved === undefined
      ? DEFAULT_CREDENTIAL_NOTICE
      : sanitizeNotice(saved);
  } catch {
    return DEFAULT_CREDENTIAL_NOTICE;
  }
}

export function saveNotice(storage, text) {
  try {
    storage?.setItem(NOTICE_STORAGE_KEY, sanitizeNotice(text));
  } catch {
    // sem armazenamento: o aviso volta ao padrão na próxima vez
  }
}

export function minutesToMs(minutes) {
  return Math.round(minutes) * 60 * 1000;
}

// Valida o formulário de "Adicionar aluno".
export function validateStudentForm({ label, quotaGb }) {
  const name = typeof label === 'string' ? label.trim() : '';
  // eslint-disable-next-line no-control-regex
  if (!name || [...name].length > 40 || /[\u0000-\u001f\u007f-\u009f]/.test(name)) {
    return { ok: false, error: 'Informe o nome do aluno (até 40 caracteres)' };
  }
  const quota = Number(String(quotaGb).replace(',', '.'));
  if (!Number.isInteger(quota) || quota < 1 || quota > MAX_QUOTA_GB) {
    return { ok: false, error: `A cota deve ser um número inteiro de 1 a ${MAX_QUOTA_GB} GB` };
  }
  return { ok: true, label: name, quotaGb: quota };
}

// Valida os tempos da reserva (em minutos), vindos de campos de texto.
export function validateReservationForm({ validityMin, startWithinMin }) {
  const validity = Number(validityMin);
  if (!Number.isInteger(validity) || validity < MIN_VALIDITY_MIN || validity > MAX_VALIDITY_MIN) {
    return {
      ok: false,
      error: `A duração deve ser de ${MIN_VALIDITY_MIN} minutos a ${MAX_VALIDITY_MIN / 60} horas`,
    };
  }
  const start = Number(startWithinMin);
  if (!Number.isInteger(start) || start < MIN_START_WITHIN_MIN || start > MAX_START_WITHIN_MIN) {
    return { ok: false, error: 'O prazo para entrar deve ser de 1 minuto a 24 horas' };
  }
  return {
    ok: true,
    validityMin: validity,
    startWithinMs: minutesToMs(start),
    sessionMs: minutesToMs(validity),
  };
}

export function deleteConfirmText(student) {
  const name = student?.label || student?.account || 'o aluno';
  return `Apagar ${name} e ${formatGb(student?.usedGb)} de arquivos?`;
}

// Por que uma ação falhou, em uma frase para o professor.
export function describeActionError(result, timeZone) {
  if (!result) return 'Não foi possível concluir a ação';
  const who = result.busyWith;
  if (result.error === 'busy' && who?.label) {
    const until = who.endsAt ? ` até ${formatClock(who.endsAt, timeZone)}` : '';
    return `O PC está com ${who.label}${until}. Use "Trocar aluno" para passar o PC.`;
  }
  const base = result.message || 'Não foi possível concluir a ação';
  if (result.step === 'reserve' && result.ended) {
    return `${base} A sessão anterior já foi encerrada.`;
  }
  return base;
}

// A reserva em andamento, em uma linha: "Ana · em uso · faltam 42 min (até 14:30)".
export function describeReservation(reservation, now = Date.now(), timeZone) {
  if (!reservation) return '';
  const parts = [
    reservation.label || reservation.account,
    studentStateLabel(reservation.state).toLowerCase(),
  ];
  // Antes da primeira entrada o relógio da sessão ainda não começou: o fim é o MÁXIMO.
  if (reservation.state === 'reserved') {
    if (reservation.startBy) parts.push(`entrar até ${formatClock(reservation.startBy, timeZone)}`);
    if (reservation.endsAt) {
      parts.push(`termina no máximo às ${formatClock(reservation.endsAt, timeZone)}`);
    }
    return parts.join(' · ');
  }
  const left = timeLeftText(reservation.endsAt, now);
  if (left) parts.push(`${left} (até ${formatClock(reservation.endsAt, timeZone)})`);
  return parts.join(' · ');
}
