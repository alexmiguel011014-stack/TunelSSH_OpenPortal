'use strict';

// Publica no Supabase o acesso que o professor acabou de liberar (GOALS 21), para o aplicativo do
// aluno mostrá-lo em "Meu acesso". Roda no app do professor, logo depois de a ação do laboratório
// dar certo: é o único lugar onde a senha existe (a resposta de `lab-reserve`).
//
// Regras:
//  - Nunca desfaz nem atrasa a ação do laboratório: toda falha vira { status: 'failed' } com uma
//    frase, e a tela do professor continua oferecendo "Copiar mensagem".
//  - A senha só vai na linha enviada ao banco. Nunca em log, em estado ou em resposta à tela.
//  - Sem conta de professor ativa (build sem contas, "sem conta") não há o que publicar: devolve null
//    e a tela não menciona o assunto.
//  - O acesso anterior do mesmo PC sai antes do novo entrar (uma troca de aluno), e some quando o
//    acesso termina; o que vencer sozinho é apagado pela limpeza do banco.

const { describeAuthError } = require('../auth/errors');

const TIMEOUT_MS = 8000;

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'timeout' })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const isoOrNull = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);

function createHandoverPublisher({ getContext, log = () => {}, timeoutMs = TIMEOUT_MS }) {
  const failed = (error) => {
    const info = describeAuthError(error);
    log(`acesso não publicado (${info.code})`);
    return { status: 'failed', message: info.message.replace(/\.$/, '') };
  };

  // Roda `work` com o contexto do professor; nunca lança.
  async function guarded(work) {
    const ctx = getContext();
    if (!ctx) return null;
    try {
      return await withTimeout(work(ctx), timeoutMs);
    } catch (error) {
      return failed(error);
    }
  }

  // O uso é estritamente sequencial (um aluno por PC), então "o acesso deste PC" é uma linha só:
  // as ações agem pelo PC, sem depender de o id da reserva coincidir nas duas pontas.
  async function remove(ctx, hostId) {
    const { error } = await ctx.client.from('lab_handovers').delete().eq('host_id', hostId);
    if (error) throw error;
  }

  // Depois de reservar (ou da parte "reservar" de uma troca de aluno).
  function publishReservation(hostId, result) {
    const { credentials, pc } = result;
    return guarded(async (ctx) => {
      const found = await ctx.client
        .from('lab_student_links')
        .select('student_id,label')
        .eq('host_id', hostId)
        .eq('windows_account', credentials.account)
        .maybeSingle();
      if (found.error) throw found.error;

      // O acesso anterior deste PC acabou (ou está sendo trocado), tenha ou não aluno vinculado agora.
      await remove(ctx, hostId);

      if (!found.data) {
        return {
          status: 'skipped',
          message: `${credentials.account} não tem conta vinculada: use Copiar mensagem`,
        };
      }
      const endsAt = isoOrNull(credentials.endsAt);
      if (!endsAt)
        throw Object.assign(new Error('sem horário de término'), { code: 'bad-request' });

      const { error } = await ctx.client.from('lab_handovers').insert({
        student_id: found.data.student_id,
        created_by: ctx.profile.id,
        reservation_id: credentials.reservationId,
        host_id: hostId,
        host_name: pc.name,
        host_address: pc.host,
        windows_user: credentials.userName,
        password: credentials.password,
        start_by: isoOrNull(credentials.startBy),
        ends_at: endsAt,
      });
      if (error) throw error;
      log(`acesso publicado (reserva ${credentials.reservationId})`);
      return { status: 'sent', message: `Enviado para o app de ${found.data.label}` };
    });
  }

  // `reserve` e `handOver` do gerente: o resultado diz o que aconteceu.
  async function afterReserve(hostId, result) {
    if (!result) return null;
    if (result.ok && result.credentials && result.pc) return publishReservation(hostId, result);
    // A troca encerrou quem estava e não conseguiu reservar o próximo: o acesso antigo acabou.
    if (!result.ok && result.step === 'reserve' && result.ended) {
      return guarded(async (ctx) => {
        await remove(ctx, hostId);
        return null;
      });
    }
    return null;
  }

  async function afterExtend(hostId, result) {
    if (!result?.ok) return null;
    const endsAt = isoOrNull(result.endsAt);
    if (!endsAt) return null;
    return guarded(async (ctx) => {
      const { error } = await ctx.client
        .from('lab_handovers')
        .update({ ends_at: endsAt })
        .eq('host_id', hostId);
      if (error) throw error;
      return { status: 'sent', message: 'Novo horário enviado ao app do aluno' };
    });
  }

  async function afterEnd(hostId, result) {
    if (!result?.ok) return null;
    return guarded(async (ctx) => {
      await remove(ctx, hostId);
      return null;
    });
  }

  return { afterReserve, afterExtend, afterEnd };
}

module.exports = { createHandoverPublisher };
