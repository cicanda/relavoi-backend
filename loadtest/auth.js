// k6 load test: POST /v1/auth/token in a tight loop.
//
// Threshold: p95 < 200ms

import http from 'k6/http';
import { check } from 'k6';
import { BASE_URL, API_KEY, API_SECRET } from './config.js';

export const options = {
  vus: Number(__ENV.VUS || 20),
  duration: __ENV.DURATION || '30s',
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<200'],
  },
};

export default function () {
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

  check(res, {
    'status 200': (r) => r.status === 200,
    'has token': (r) => {
      try {
        const body = r.json();
        return typeof (body.token || body.access_token) === 'string';
      } catch (_e) {
        return false;
      }
    },
  });
}
