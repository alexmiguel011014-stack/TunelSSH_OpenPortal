'use strict';

const net = require('net');

/**
 * MockRemoteServer: Simula um PC remoto respondendo a conexões.
 * Útil para testar diálogos de aprovação/rejeição sem ter 2 PCs.
 *
 * Modes:
 * - 'approve': Sempre aprova conexões
 * - 'reject': Sempre rejeita conexões
 * - 'toggle': Alterna entre aprovar/rejeitar (interativo)
 */
class MockRemoteServer {
  constructor(port = 18903) {
    this.port = port;
    this.server = null;
    this.mode = 'approve'; // approve | reject | toggle
    this.nextAction = 'approve'; // para mode === 'toggle'
  }

  start() {
    this.server = net.createServer((socket) => {
      socket.setNoDelay(true);
      let buffer = Buffer.alloc(0);

      const handleData = (data) => {
        buffer = Buffer.concat([buffer, data]);
        let msg = null;
        try {
          msg = JSON.parse(buffer.toString('utf8'));
        } catch {}

        if (!msg) return;

        if (msg.type === 'connect-request') {
          console.log(`[mock] Recebeu connect-request:`, {
            fromName: msg.fromName,
            fromIp: msg.fromIp,
            capability: msg.capability
          });

          // Determinar ação baseado no modo
          let approved = false;
          if (this.mode === 'approve') {
            approved = true;
          } else if (this.mode === 'reject') {
            approved = false;
          } else if (this.mode === 'toggle') {
            approved = this.nextAction === 'approve';
            this.nextAction = this.nextAction === 'approve' ? 'reject' : 'approve';
            console.log(`[mock] Toggle: próxima ação será ${this.nextAction}`);
          }

          const response = {
            type: 'connect-response',
            requestId: msg.requestId,
            approved,
            rejected: !approved,
            message: approved ? 'Aprovado pelo mock server' : 'Rejeitado pelo mock server'
          };

          console.log(`[mock] Enviando resposta:`, response);
          socket.write(JSON.stringify(response));

          // Para approved + tunnel: manter socket aberto (upgrade)
          if (!approved || msg.capability !== 'tunnel') {
            socket.end();
          }
        } else {
          console.log(`[mock] Mensagem desconhecida:`, msg);
          socket.write(JSON.stringify({
            type: 'connect-response',
            approved: false,
            message: 'Unknown request type'
          }));
          socket.end();
        }
      };

      socket.on('data', handleData);
      socket.on('error', (err) => {
        console.error(`[mock] Socket error:`, err.message);
      });
    });

    this.server.on('error', (err) => {
      console.error(`[mock] Server error:`, err.message);
    });

    this.server.listen(this.port, '127.0.0.1', () => {
      console.log(`[mock] Mock server rodando em 127.0.0.1:${this.port} (modo: ${this.mode})`);
    });

    return this.server;
  }

  stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
      console.log(`[mock] Mock server parado`);
    }
  }

  setMode(mode) {
    if (!['approve', 'reject', 'toggle'].includes(mode)) {
      console.error(`[mock] Modo inválido: ${mode}. Use: approve, reject, toggle`);
      return;
    }
    this.mode = mode;
    this.nextAction = 'approve';
    console.log(`[mock] Modo alterado para: ${mode}`);
  }
}

module.exports = { MockRemoteServer };
