function hasOwn(object, property) {
  return Object.prototype.hasOwnProperty.call(object, property);
}

function toRendererMachine(machine) {
  const { passwordEnc, ...publicMachine } = machine || {};
  return { ...publicMachine, hasVncPassword: Boolean(passwordEnc) };
}

function mergeStoredMachine(existingMachine, incomingMachine, encryptSecret) {
  const incoming = incomingMachine || {};
  const publicMachine = { ...incoming };
  const password = publicMachine.password;
  delete publicMachine.password;
  delete publicMachine.hasVncPassword;
  const next = { ...(existingMachine || {}), ...publicMachine };
  delete next.password;

  if (hasOwn(incoming, 'password')) {
    delete next.passwordEnc;
    if (password) next.passwordEnc = encryptSecret(password);
  }

  return next;
}

module.exports = { mergeStoredMachine, toRendererMachine };
