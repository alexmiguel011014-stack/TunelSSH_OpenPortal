import http from 'http';

// Um servidor local que fala o suficiente de GoTrue (login) e PostgREST (tabelas) para os testes
// usarem o @supabase/supabase-js DE VERDADE, sem rede: o que se verifica são os formatos de erro e
// de consulta que a biblioteca real produz e que o app lê (código `invalid_credentials`, falha de rede,
// filtros `eq`/`not.is`/`gt`, corpos de insert/update/rpc). Nada aqui prova segurança: ela está no
// banco e é provada em supabase/tests.

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

function jwtFor(user, expiresAt) {
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({
    sub: user.id,
    aud: 'authenticated',
    role: 'authenticated',
    exp: expiresAt,
  })}.sig`;
}

export const GOOD_CODE = '123456';

export async function startFakeSupabase() {
  const requests = [];
  const users = new Map(); // email -> { id, email, password, confirmed, meta }
  const profiles = new Map(); // id -> row
  const state = {
    teacherRows: [],
    handoverRows: [],
    rateLimitEmails: false,
    refreshTokens: new Map(),
  };
  let nextId = 1;

  const sessionFor = (user, ttl = 3600) => {
    const expiresAt = Math.floor(Date.now() / 1000) + ttl;
    const refresh = `refresh-${nextId++}`;
    state.refreshTokens.set(refresh, user.email);
    return {
      access_token: jwtFor(user, expiresAt),
      token_type: 'bearer',
      expires_in: ttl,
      expires_at: expiresAt,
      refresh_token: refresh,
      user: {
        id: user.id,
        aud: 'authenticated',
        role: 'authenticated',
        email: user.email,
        email_confirmed_at: user.confirmed ? new Date().toISOString() : null,
        user_metadata: user.meta || {},
      },
    };
  };

  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  const authError = (res, status, code, msg) =>
    send(res, status, { code: status, error_code: code, msg });

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url, 'http://127.0.0.1');
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {}
      requests.push({
        method: req.method,
        path: url.pathname,
        search: url.search,
        query: Object.fromEntries(url.searchParams),
        body,
        headers: req.headers,
      });
      const path = url.pathname;

      // ---- GoTrue ----
      if (path === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
        const user = users.get(String(body?.email).toLowerCase());
        if (!user || user.password !== body.password) {
          return authError(res, 400, 'invalid_credentials', 'Invalid login credentials');
        }
        if (!user.confirmed)
          return authError(res, 400, 'email_not_confirmed', 'Email not confirmed');
        return send(res, 200, sessionFor(user));
      }
      if (path === '/auth/v1/token' && url.searchParams.get('grant_type') === 'refresh_token') {
        const email = state.refreshTokens.get(body?.refresh_token);
        const user = email && users.get(email);
        if (!user) return authError(res, 400, 'refresh_token_not_found', 'Invalid Refresh Token');
        return send(res, 200, sessionFor(user));
      }
      if (path === '/auth/v1/signup') {
        if (state.rateLimitEmails) {
          return authError(res, 429, 'over_email_send_rate_limit', 'email rate limit exceeded');
        }
        const email = String(body.email).toLowerCase();
        const user = {
          id: `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`,
          email,
          password: body.password,
          confirmed: false,
          meta: body.data,
        };
        users.set(email, user);
        profiles.set(user.id, {
          id: user.id,
          email,
          full_name: body.data?.full_name || email,
          role: 'aluno',
          teacher_requested_at: body.data?.wants_teacher ? new Date().toISOString() : null,
        });
        return send(res, 200, {
          id: user.id,
          aud: 'authenticated',
          role: '',
          email,
          confirmation_sent_at: new Date().toISOString(),
          user_metadata: body.data,
          identities: [{ id: user.id }],
        });
      }
      if (path === '/auth/v1/verify') {
        const user = users.get(String(body?.email).toLowerCase());
        if (!user || body.token !== GOOD_CODE) {
          return authError(res, 403, 'otp_expired', 'Token has expired or is invalid');
        }
        user.confirmed = true;
        return send(res, 200, sessionFor(user));
      }
      if (path === '/auth/v1/resend' || path === '/auth/v1/recover') {
        if (state.rateLimitEmails) {
          return authError(res, 429, 'over_email_send_rate_limit', 'email rate limit exceeded');
        }
        return send(res, 200, {});
      }
      if (path === '/auth/v1/user' && req.method === 'PUT') {
        const token = String(req.headers.authorization || '').replace('Bearer ', '');
        const claims = JSON.parse(
          Buffer.from(token.split('.')[1] || 'e30', 'base64url').toString(),
        );
        const user = [...users.values()].find((candidate) => candidate.id === claims.sub);
        if (!user) return authError(res, 401, 'bad_jwt', 'invalid JWT');
        if (body.password === user.password) {
          return authError(
            res,
            422,
            'same_password',
            'New password should be different from the old password.',
          );
        }
        user.password = body.password;
        return send(res, 200, { id: user.id, email: user.email });
      }
      if (path === '/auth/v1/logout') return send(res, 204);

      // ---- PostgREST ----
      if (path === '/rest/v1/profiles' && req.method === 'GET') {
        const id = url.searchParams.get('id');
        if (id) {
          const row = profiles.get(String(id).replace(/^eq\./, ''));
          return send(res, 200, row ? [row] : []);
        }
        return send(res, 200, state.teacherRows);
      }
      if (path === '/rest/v1/lab_handovers' && req.method === 'GET')
        return send(res, 200, state.handoverRows);
      if (path.startsWith('/rest/v1/rpc/')) return send(res, 200, null);
      if (path.startsWith('/rest/v1/')) {
        if (req.method === 'POST') return send(res, 201);
        if (req.method === 'GET') return send(res, 200, []);
        return send(res, 204);
      }
      return send(res, 404, { message: 'not found' });
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    users,
    profiles,
    state,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
    sessionFor,
  };
}
