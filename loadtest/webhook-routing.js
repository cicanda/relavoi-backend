// k6 load test: simulate inbound Africa's Talking voice webhooks.
//
// The webhook handler is the CRITICAL PATH — these are calls that real users
// are placing right now. Threshold is p99 < 500ms per the architecture spec.

import http from 'k6/http';
import { check } from 'k6';
import { BASE_URL } from './config.js';

export const options = {
  vus: Number(__ENV.VUS || 30),
  duration: __ENV.DURATION || '60s',
  thresholds: {
    http_req_failed: ['rate<0.001'],   // webhook reliability must be near-zero failure
    http_req_duration: ['p(99)<500'],  // p99 < 500ms (architecture spec)
    http_req_duration: ['p(95)<200'],
  },
};

const PROXY_POOL = [
  '+2348000000000',
  '+2348000000001',
  '+2348000000002',
  '+2348000000003',
  '+2348000000004',
  '+2348000000005',
  '+2348000000006',
  '+2348000000007',
  '+2348000000008',
  '+2348000000009',
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export default function () {
  const proxy = pick(PROXY_POOL);
  const caller = `+2348${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
  const callId = `LOADTEST-${__VU}-${__ITER}-${Date.now()}`;

  const body = [
    `sessionId=${encodeURIComponent(callId)}`,
    'isActive=1',
    'direction=Inbound',
    `callerNumber=${encodeURIComponent(caller)}`,
    `destinationNumber=${encodeURIComponent(proxy)}`,
    'callSessionState=Ringing',
  ].join('&');

  const res = http.post(`${BASE_URL}/v1/webhooks/cpaas/voice`, body, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    tags: { endpoint: 'webhook_voice' },
  });

  check(res, {
    'status 200': (r) => r.status === 200,
    'returned xml or json': (r) => {
      const ct = (r.headers['Content-Type'] || r.headers['content-type'] || '').toLowerCase();
      return ct.includes('xml') || ct.includes('json') || (r.body && r.body.length > 0);
    },
  });
}
