import { describe, it, expect, vi } from 'vitest';
import {
  ConnectionRequestServer,
  sendConnectRequest,
  sendActivityEvent,
} from '../connection-request.js';

// GOALS 4's wire protocol ("Implementation — wire protocol") was only ever
// verified once by hand, in a previous session, per this module's own
// history in GOALS.md ("sending a hand-crafted activity-event message...").
// This captures that same proof as a real regression test: a real
// ConnectionRequestServer, on a real (ephemeral, loopback) port, exercised
// through its actual public client functions — no mocking of `net`.
function startServer(onRequest) {
  return new Promise((resolve) => {
    const server = new ConnectionRequestServer(onRequest);
    server.start(0);
    server.server.once('listening', () => resolve(server));
  });
}

describe('ConnectionRequestServer', () => {
  it('routes a connect-request to onRequest and relays the approval back', async () => {
    const received = [];
    const server = await startServer((req, respond) => {
      received.push(req);
      respond({
        type: 'connect-response',
        requestId: req.requestId,
        approved: true,
      });
    });
    const port = server.server.address().port;
    try {
      const res = await sendConnectRequest('127.0.0.1', 'Tester', '127.0.0.1', port);
      expect(res.approved).toBe(true);
      expect(received).toHaveLength(1);
      expect(received[0].fromName).toBe('Tester');
    } finally {
      server.stop();
    }
  });

  it('routes an activity-event to the activity-event emitter, never to onRequest', async () => {
    const onRequest = vi.fn();
    const events = [];
    const server = await startServer(onRequest);
    server.on('activity-event', (event) => events.push(event));
    const port = server.server.address().port;
    try {
      sendActivityEvent('127.0.0.1', { identity: 'prof@example.com', machineName: 'PC-1' }, port);
      await vi.waitFor(() => expect(events).toHaveLength(1));
      expect(events[0].identity).toBe('prof@example.com');
      expect(onRequest).not.toHaveBeenCalled();
    } finally {
      server.stop();
    }
  });

  it('an activity-event on one socket does not disturb a connect-request still pending a human decision on another', async () => {
    let pendingRespond = null;
    const server = await startServer((req, respond) => {
      // Simula o diálogo Aceitar/Rejeitar ainda não respondido — só guarda
      // a função, não chama ainda.
      pendingRespond = respond;
    });
    const events = [];
    server.on('activity-event', (event) => events.push(event));
    const port = server.server.address().port;
    try {
      const connectPromise = sendConnectRequest('127.0.0.1', 'Tester', '127.0.0.1', port);
      await vi.waitFor(() => expect(pendingRespond).not.toBeNull());

      sendActivityEvent('127.0.0.1', { identity: 'x@example.com' }, port);
      await vi.waitFor(() => expect(events).toHaveLength(1));

      // O connect-request pendente continua vivo e responde certo depois.
      pendingRespond({
        type: 'connect-response',
        requestId: 'x',
        approved: true,
      });
      const res = await connectPromise;
      expect(res.approved).toBe(true);
    } finally {
      server.stop();
    }
  });
});
