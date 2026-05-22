// k6 load test: create → get → end session in sequence.
//
// Threshold: p95 < 1s for the create call.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE_URL, API_KEY, API_SECRET } from './config.js';

export const options = {
  vus: Number(__ENV.VUS || 10),
  duration: __ENV.DURATION || '60s',
  thresholds: {
    http_req_failed: ['rate<0.02'],
    http_req_duration: ['p(95)<1000'],
  },
};

let cachedToken = null;

function getToken() {
  if (cachedToken) return cachedToken;
  const res = http.post(
    `${BASE_URL}/v1/auth/token`,
    JSON.stringify({}),
    {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'x-api-secret': API_SECRET,
      },
      tags: { endpoint: 'auth_token' },
    },
  );
  if (res.status !== 200) {
    return null;
  }
  try {
    const body = res.json();
    cachedToken = body.token || body.access_token;
    return cachedToken;
  } catch (_e) {
    return null;
  }
}

export default function () {
  const token = getToken();
  if (!token) {
    check(false, { 'token acquired': () => false });
    return;
  }
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };

  // Unique phone per iteration to avoid participant overlap
  const seq = `${__VU}${__ITER}${Date.now() % 100000}`.padStart(8, '0').slice(0, 8);
  const agent = `+23480100${seq}`.slice(0, 14);
  const customer = `+23480200${seq}`.slice(0, 14);

  // Create
  const createRes = http.post(
    `${BASE_URL}/v1/sessions`,
    JSON.stringify({
      agentPhone: agent,
      customerPhone: customer,
      metadata: { loadtest: true, vu: __VU, iter: __ITER },
      gracePeriodMinutes: 1,
    }),
    { headers, tags: { endpoint: 'session_create' } },
  );

  const ok = check(createRes, {
    'create status 200/201': (r) => r.status === 200 || r.status === 201,
  });
  if (!ok) return;

  let sessionId;
  try {
    const body = createRes.json();
    sessionId = body.id || body.session?.id;
  } catch (_e) {
    return;
  }
  if (!sessionId) return;

  // Get
  const getRes = http.get(`${BASE_URL}/v1/sessions/${sessionId}`, {
    headers,
    tags: { endpoint: 'session_get' },
  });
  check(getRes, { 'get status 200': (r) => r.status === 200 });

  sleep(0.1);

  // End
  const endRes = http.post(`${BASE_URL}/v1/sessions/${sessionId}/end`, null, {
    headers,
    tags: { endpoint: 'session_end' },
  });
  check(endRes, { 'end status 200/204': (r) => r.status === 200 || r.status === 204 });
}
