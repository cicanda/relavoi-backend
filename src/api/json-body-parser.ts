/**
 * Structural subset of Fastify we need. Typed this way rather than as
 * FastifyInstance because the production app (built with `loggerInstance`) and
 * the test app resolve to different Fastify generic instantiations, which are
 * mutually unassignable.
 */
interface ContentTypeParserHost {
  addContentTypeParser(
    contentType: string,
    opts: { parseAs: 'string' },
    parser: (
      req: unknown,
      body: string,
      done: (err: Error | null, result?: unknown) => void,
    ) => void,
  ): unknown;
}

/**
 * Replace Fastify's stock application/json parser with one that tolerates an
 * empty body.
 *
 * Fastify rejects a zero-length payload sent with Content-Type:
 * application/json (FST_ERR_CTP_EMPTY_JSON_BODY), which is raised by the
 * content-type parser before route schema validation — so a permissive `body`
 * schema on the route cannot fix it. Several endpoints take no payload at all
 * (POST /sessions/:id/end being the clearest), and clients routinely send the
 * JSON content-type header regardless. Parsing an empty body as {} lets those
 * calls through.
 *
 * This does not weaken validation: routes that require fields still reject {}
 * via their own zod schema and return an RFC 7807 problem document.
 *
 * Registered by both the production app (src/index.ts) and the integration test
 * harness (test/helpers/integration.ts) so the two agree on body handling.
 */
export function registerJsonBodyParser(app: ContentTypeParserHost): void {
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const raw = typeof body === 'string' ? body.trim() : '';
    if (raw === '') return done(null, {});
    try {
      done(null, JSON.parse(raw));
    } catch (err) {
      (err as Error & { statusCode?: number }).statusCode = 400;
      done(err as Error, undefined);
    }
  });
}
