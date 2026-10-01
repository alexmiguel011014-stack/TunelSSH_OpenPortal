'use strict';

const crypto = require('crypto');
const labConfig = require('./lab-config');

// Liga as regras de lab-config.js ao arquivo de configuração. `read` e `write`
// são as funções de config-manager.js (o config guardado, com segredos
// cifrados); injetadas para que o teste use um config em memória.
function createLabStore({ read, write, randomUUID = crypto.randomUUID }) {
  const save = (config, lab) => {
    write({ ...config, lab: labConfig.toStoredLab(lab) });
  };

  // `hostId` é criado uma vez e nunca muda: identifica o PC para o gerente.
  function getHostId() {
    const config = read();
    if (typeof config.hostId === 'string' && config.hostId) return config.hostId;
    const hostId = randomUUID();
    write({ ...config, hostId });
    return hostId;
  }

  function getLab() {
    return labConfig.readLab(read());
  }

  function addManager(login) {
    const config = read();
    const result = labConfig.addManager(config, login);
    if (result.ok && result.added) save(config, result.lab);
    return result;
  }

  function removeManager(login) {
    const config = read();
    const result = labConfig.removeManager(config, login);
    if (result.removed) save(config, result.lab);
    return result;
  }

  function upsertRosterEntry(entry) {
    const config = read();
    const result = labConfig.upsertRosterEntry(config, entry);
    if (result.ok) save(config, result.lab);
    return result;
  }

  function removeRosterEntry(hostId) {
    const config = read();
    const result = labConfig.removeRosterEntry(config, hostId);
    if (result.removed) save(config, result.lab);
    return result;
  }

  // Só o main chama (o renderer pede por um canal próprio, que valida): quantos dias o registro
  // de acessos guarda.
  function setLogRetentionDays(days) {
    const config = read();
    const lab = labConfig.readLab(config);
    const next = labConfig.clampRetentionDays(days);
    save(config, { ...lab, logRetentionDays: next });
    return next;
  }

  return {
    getHostId,
    getLab,
    setLogRetentionDays,
    addManager,
    removeManager,
    upsertRosterEntry,
    removeRosterEntry,
  };
}

module.exports = { createLabStore };
