import { vi } from 'vitest';

// Um banco de mentira para os testes de "Meu acesso": cada consulta fica registrada em `ops`
// ({ table, kind, payload, filters, ... }) e a resposta vem do `script` ("tabela.tipo" → resultado,
// ou uma função que recebe a operação). Sem script, devolve vazio e sem erro.

export function createFakeDb(script = {}) {
  const ops = [];
  const channels = [];

  const client = {
    ops,
    channels,
    from(table) {
      const op = { table, kind: 'select', filters: [], payload: undefined, modifiers: [] };
      const finish = (mode) => {
        ops.push(op);
        const handler = script[`${table}.${op.kind}`];
        const result =
          typeof handler === 'function'
            ? handler(op, mode)
            : (handler ?? { data: mode === 'single' ? null : [], error: null });
        return Promise.resolve(result);
      };
      const chain = {
        select: (columns) => {
          op.columns = columns;
          return chain;
        },
        insert: (payload) => {
          op.kind = 'insert';
          op.payload = payload;
          return chain;
        },
        update: (payload) => {
          op.kind = 'update';
          op.payload = payload;
          return chain;
        },
        delete: () => {
          op.kind = 'delete';
          return chain;
        },
        eq: (column, value) => {
          op.filters.push(['eq', column, value]);
          return chain;
        },
        in: (column, values) => {
          op.filters.push(['in', column, values]);
          return chain;
        },
        gt: (column, value) => {
          op.filters.push(['gt', column, value]);
          return chain;
        },
        or: (expression) => {
          op.filters.push(['or', expression]);
          return chain;
        },
        order: (column, options) => {
          op.modifiers.push(['order', column, options]);
          return chain;
        },
        limit: (count) => {
          op.modifiers.push(['limit', count]);
          return chain;
        },
        maybeSingle: () => finish('single'),
        then: (onFulfilled, onRejected) => finish('list').then(onFulfilled, onRejected),
      };
      return chain;
    },
    channel(name) {
      const channel = {
        name,
        handlers: [],
        subscribed: false,
        removed: false,
        on(type, filter, callback) {
          channel.handlers.push({ type, filter, callback });
          return channel;
        },
        subscribe() {
          channel.subscribed = true;
          return channel;
        },
      };
      channels.push(channel);
      return channel;
    },
    removeChannel: vi.fn(async (channel) => {
      channel.removed = true;
    }),
  };

  return client;
}

export const find = (client, table, kind) =>
  client.ops.filter((op) => op.table === table && op.kind === kind);
