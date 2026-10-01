'use strict';

// A entrega "ao vivo" do diário (GOALS 19): este app, no PC de laboratório, olha o diário do serviço a
// cada poucos segundos e empurra cada evento novo para os gerentes (melhor esforço, pela mesma porta
// de sinalização). O diário já foi gravado antes (o serviço grava primeiro), então um gerente que
// estava fora do ar ou perdeu um empurrão recupera tudo depois pelo número de sequência
// (`lab-events`): o push só adianta o que a consulta entregaria em até 10 s.
//
// Começa a empurrar a partir do que existe quando o app sobe; o que veio antes é do gerente buscar.

const events = require('./events');

function createJournalFeed({
  service,
  getTargets,
  push,
  hostIdentity,
  intervalMs = 2000,
  pageSize = 100,
  log = () => {},
  setTimer = setInterval,
  clearTimer = clearInterval,
}) {
  let cursor = null;
  let busy = false;
  let timer = null;

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      if (cursor === null) {
        const head = await service.events({ sinceSeq: 0, limit: 1 }, { timeoutMs: 3000 });
        if (head?.ok) cursor = Number.isSafeInteger(head.lastSeq) ? head.lastSeq : 0;
        return;
      }
      const page = await service.events({ sinceSeq: cursor, limit: pageSize }, { timeoutMs: 3000 });
      if (!page?.ok) return;
      // O diário recomeçou (apagado ou reinstalado): volta a acompanhar do novo fim.
      if (Number.isSafeInteger(page.lastSeq) && page.lastSeq < cursor) {
        cursor = page.lastSeq;
        return;
      }
      const entries = Array.isArray(page.events) ? page.events : [];
      if (entries.length === 0) return;
      cursor = Math.max(
        cursor,
        ...entries.map((entry) => (Number.isSafeInteger(entry?.seq) ? entry.seq : 0)),
      );
      const pc = hostIdentity();
      const ready = entries.map((entry) => events.fromJournalEntry(entry, pc)).filter(Boolean);
      if (ready.length === 0) return;
      const targets = (await getTargets()) || [];
      for (const ip of targets) {
        for (const event of ready) {
          try {
            push(ip, event);
          } catch (err) {
            log(`push de evento para ${ip} falhou: ${err?.message || err}`);
          }
        }
      }
    } catch (err) {
      log(`entrega do diário falhou: ${err?.message || err}`);
    } finally {
      busy = false;
    }
  }

  function start() {
    if (timer) return;
    timer = setTimer(() => {
      tick().catch(() => {});
    }, intervalMs);
    timer.unref?.();
    tick().catch(() => {});
  }

  function stop() {
    if (timer) clearTimer(timer);
    timer = null;
  }

  return { start, stop, tick, position: () => cursor };
}

module.exports = { createJournalFeed };
