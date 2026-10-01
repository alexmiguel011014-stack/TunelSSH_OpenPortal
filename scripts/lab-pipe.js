'use strict';

// Fala com o serviço do laboratório (GOALS 17) pelo pipe local, como o app faz.
// Serve para o teste de dois PCs enquanto as telas dos alunos (GOALS 18) não
// existem, e para diagnosticar um PC de laboratório. Só funciona na conta que
// roda o OpenPortal (a dona do pipe).
//
//   node scripts/lab-pipe.js status
//   node scripts/lab-pipe.js disk-info
//   node scripts/lab-pipe.js student-create '{"label":"Ana","quotaGb":25}'
//   node scripts/lab-pipe.js reserve '{"account":"ana","startWithinMs":1800000,"sessionMs":3600000}'
//   node scripts/lab-pipe.js end '{"reservationId":"...","reason":"manager-ended"}'
//
// A resposta de `reserve` traz a senha do aluno: ela aparece só neste terminal.

const { COMMANDS, createServiceClient } = require('../src/main/lab/service-client');

async function main() {
  const [cmd, rawFields] = process.argv.slice(2);
  if (!cmd || !COMMANDS.includes(cmd)) {
    console.error(`Uso: node scripts/lab-pipe.js <${COMMANDS.join('|')}> ['{"campo":"valor"}']`);
    process.exit(2);
  }
  let fields = {};
  if (rawFields) {
    try {
      fields = JSON.parse(rawFields);
    } catch {
      console.error('Os campos precisam ser um JSON válido.');
      process.exit(2);
    }
  }
  // `end` espera o aviso e o logoff: dá mais tempo.
  const timeoutMs = cmd === 'end' ? 90_000 : 10_000;
  const result = await createServiceClient().request(cmd, fields, {
    timeoutMs,
  });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

main();
