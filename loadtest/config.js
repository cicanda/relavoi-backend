// Shared k6 configuration & dev credentials.
//
// Import this from individual load scripts:
//   import { options, BASE_URL, API_KEY, API_SECRET } from './config.js';

export const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
export const API_KEY = __ENV.API_KEY || 'sk_test_relavoi_dev_0123456789abcdef';
export const API_SECRET = __ENV.API_SECRET || 'secret_test_relavoi_dev_fedcba9876543210';

// Default load profile — individual scripts may override these in their own options.
export const options = {
  vus: Number(__ENV.VUS || 20),
  duration: __ENV.DURATION || '30s',
  thresholds: {
    http_req_failed: ['rate<0.01'],          // <1% errors
    http_req_duration: ['p(95)<500'],        // p95 < 500ms baseline
    http_req_duration: ['p(99)<1000'],       // p99 < 1s baseline
  },
  noConnectionReuse: false,
  discardResponseBodies: false,
};
