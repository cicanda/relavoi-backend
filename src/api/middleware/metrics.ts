import type { FastifyReply, FastifyRequest } from 'fastify';
import { httpRequestDuration, httpRequestTotal } from '../../utils/metrics';

/**
 * Fastify `onResponse` hook: records HTTP metrics. Never throws.
 */
export function metricsHook(req: FastifyRequest, reply: FastifyReply): void {
  try {
    const method = req.method;
    // Prefer route template (e.g. "/v1/sessions/:id") to avoid label cardinality blowup.
    const route =
      (req.routeOptions && req.routeOptions.url) ||
      (req.routeOptions as unknown as { url?: string })?.url ||
      req.url ||
      'unknown';
    const statusCode = String(reply.statusCode);

    const labels = { method, route, status_code: statusCode };

    httpRequestTotal.inc(labels);

    // Fastify exposes elapsed time in ms via reply.elapsedTime (v5+).
    const elapsedMs =
      typeof (reply as unknown as { elapsedTime?: number }).elapsedTime === 'number'
        ? (reply as unknown as { elapsedTime: number }).elapsedTime
        : 0;
    if (elapsedMs > 0) {
      httpRequestDuration.observe(labels, elapsedMs / 1000);
    }
  } catch {
    // never throw from metrics hook
  }
}
