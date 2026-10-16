import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { armLifecycleRoutes, entraArmRoutes } from './auth/arm-routes';
import { mockAuthRoutes } from './auth/mock-routes';
import { entraSignInRoutes, sessionEndRoutes } from './auth/routes';
import { requireRole } from './auth/guards';
import { registerSessions } from './auth/session-plugin';
import { webDistAvailable, type Config } from './config';
import { createContext, type AppContext, type AppDeps } from './context';
import { serializeError } from './logging';
import { AppError, DenialAudit, registerErrorHandler, sendError, unauthenticated } from './errors';
import { contentRoutes } from './routes/content';
import { healthRoutes } from './routes/health';
import { meRoutes } from './routes/me';
import { navRoutes } from './routes/nav';
import { overviewRoutes } from './routes/overview';
import { approvalRoutes } from './routes/approvals';
import { probeRoutes } from './routes/probes';
import { newsRoutes } from './routes/news';
import { queryRoutes } from './routes/query';
import { reportCatalogRoutes } from './routes/report-catalog';
import { runRoutes } from './routes/runs';
import { scheduleRoutes } from './routes/schedules';
import { createRunsModule } from './runs/module';
import { createSchedulesModule, type SchedulesOptions } from './schedules/module';
import { assertCsrf, isSafeMethod } from './security/csrf';

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
  }
}

/** Query parameters that must never reach the logs (auth codes, state, CAE claims, hints, Entra's error text). */
const SECRET_QUERY =
  /([?&](?:code|state|session_state|id_token|client_info|claims|login_hint|error_description)=)[^&#]*/gi;
const API_PATH = /^\/api(\/|$|\?)/;
const PARAM_NAME = /^[A-Za-z][A-Za-z0-9_.[\]-]{0,39}$/;

/**
 * The URL as logged. /api query strings carry what people look for (names in the command palette, UPNs in audit
 * filters), so only parameter names are kept there; elsewhere secrets (auth codes, state, …) are redacted.
 */
export function redactUrl(url: string): string {
  const q = url.indexOf('?');
  if (q < 0) return url;
  if (!API_PATH.test(url)) return url.replace(SECRET_QUERY, '$1[redacted]');
  const params = url
    .slice(q + 1)
    .split('#')[0]!
    .split('&')
    .filter(Boolean)
    .map((p) => {
      const eq = p.indexOf('=');
      const name = eq < 0 ? '' : p.slice(0, eq);
      return PARAM_NAME.test(name) ? `${name}=[redacted]` : '[redacted]';
    });
  return `${url.slice(0, q)}${params.length ? `?${params.join('&')}` : ''}`;
}

/** Browser features AdminForge never uses: denied to the page and anything it embeds. */
export const PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=(), payment=(), usb=()';

/**
 * /api routes that work without Portal.Reader: the shell (who am I, preferences, appearance, the event stream, the
 * emergency-stop banner) loads so the SPA can explain the missing role instead of failing blank. Everything else needs
 * Reader (docs/access.md).
 */
export const READER_EXEMPT: ReadonlySet<string> = new Set([
  'GET /api/me',
  'PUT /api/me/prefs',
  'GET /api/appearance.css',
  'GET /api/emergency',
  'GET /api/events',
]);

/** TRUST_PROXY → Fastify trustProxy: 'true'/'false' are booleans; anything else is an address/preset list ("true" would be read as a host name). */
export const trustProxyOption = (value: string): boolean | string =>
  value === 'true' ? true : value === 'false' ? false : value;

/** Paths whose responses must never be cached by the browser or a proxy. */
const NO_STORE = /^\/(api|auth)(\/|$|\?)|^\/(healthz|readyz)(\?|$)/;
const API_OR_AUTH = /^\/(api|auth)(\/|$|\?)/;
const STATIC_ASSET =
  /^\/assets\/|\.(js|mjs|css|map|json|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|txt|webmanifest|wasm)$/i;

/** Fastify/pino logger options: redaction and serializers (no bound query parameters, no secrets in URLs). */
export function loggerOptions(config: Config): FastifyServerOptions['logger'] {
  if (config.NODE_ENV === 'test') return false;
  let transport: { target: string; options: Record<string, unknown> } | undefined;
  if (config.NODE_ENV === 'development') {
    try {
      // Resolved here so pino's worker finds it under pnpm's strict layout; absent in production installs.
      transport = {
        target: createRequire(import.meta.url).resolve('pino-pretty'),
        options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
      };
    } catch {
      transport = undefined;
    }
  }
  return {
    level: config.LOG_LEVEL,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-adminforge-csrf"]',
        'res.headers["set-cookie"]',
        'headers.authorization',
        'headers.cookie',
      ],
      censor: '[redacted]',
    },
    serializers: {
      req: (req: { method: string; url: string; ip?: string }) => ({
        method: req.method,
        url: redactUrl(req.url),
        remoteAddress: req.ip,
      }),
      // Failed DB queries carry their bound parameters (CSRF tokens, PKCE verifiers, run inputs): never logged.
      err: serializeError,
      error: serializeError,
    },
    ...(transport ? { transport } : {}),
  };
}

/** Builds the BFF. `deps` replaces stores/clients (tests use in-memory stores and a fake AuthClient). */
export async function buildApp(
  config: Config,
  deps: AppDeps & { schedules?: SchedulesOptions } = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions(config),
    trustProxy: trustProxyOption(config.TRUST_PROXY),
    bodyLimit: 256 * 1024,
    // Always ours: the id is the audit log's "Reference", so a browser must not be able to choose (or reuse) it.
    // No internal caller sends X-Correlation-Id; outbound calls carry this id to Microsoft, not the other way round.
    genReqId: () => randomUUID(),
  });
  const ctx = createContext(config, deps, {
    warn: (obj, msg) => app.log.warn(obj, msg),
    info: (obj, msg) => app.log.info(obj, msg),
  });
  app.decorate('ctx', ctx);
  app.addHook('onClose', async () => {
    await ctx.database?.close();
  });
  // Runs (playbook engine): RunService + queue; the worker also runs here with RUN_WORKER_IN_PROCESS=true or without a database.
  const runs = createRunsModule(ctx, { ...deps.runs, log: app.log });
  app.decorate('runs', runs);
  app.addHook('onReady', () => runs.start());
  app.addHook('preClose', () => runs.stop());
  // Schedules & probes (R6): store, events, API service; the scheduler itself runs here with SCHEDULER_IN_PROCESS=true.
  const schedules = createSchedulesModule(ctx, runs, { ...deps.schedules, log: app.log });
  app.decorate('schedules', schedules);
  app.addHook('onReady', () => schedules.start());
  app.addHook('preClose', () => schedules.stop());

  // Security-relevant refusals (roles, CSRF, policy, self-approval, …) are audited, rate-limited per session and code.
  registerErrorHandler(app, { denials: new DenialAudit({ audit: ctx.audit, now: ctx.now }) });

  // Bodiless POSTs (disarm, logout) often still carry Content-Type: application/json; treat "" as no body.
  // Everything else goes through Fastify's own parser (prototype-poisoning protection included).
  const jsonParser = app.getDefaultJsonParser('error', 'error');
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (text.trim() === '') return done(null, undefined);
    return jsonParser(request, text, done);
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-correlation-id', request.id);
    reply.header('permissions-policy', PERMISSIONS_POLICY);
  });
  app.addHook('onSend', async (request, reply) => {
    if (NO_STORE.test(request.url)) reply.header('cache-control', 'no-store');
  });

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // Styles keep 'unsafe-inline': Radix (positioning) and Monaco inject <style> elements and style attributes at
        // runtime. Accepted risk (docs/decisions.md): CSS injection can't run script — script-src stays 'self' only.
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        // Monaco runs its language services in web workers.
        workerSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: config.PUBLIC_BASE_URL.startsWith('https://') ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
    frameguard: { action: 'deny' },
    hsts: config.NODE_ENV === 'production' ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    referrerPolicy: { policy: 'no-referrer' },
  });
  await app.register(rateLimit, { max: config.RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' });

  registerSessions(app, ctx);

  healthRoutes(app, ctx);
  sessionEndRoutes(app, ctx);
  armLifecycleRoutes(app, ctx);
  if (config.AUTH_MODE === 'mock') {
    mockAuthRoutes(app, ctx);
  } else {
    if (!ctx.auth) throw new Error('AUTH_MODE=entra needs an AuthClient');
    entraSignInRoutes(app, ctx);
    entraArmRoutes(app, ctx);
  }

  await app.register(
    async (api) => {
      // Every /api call needs a session and (apart from the shell's few) Portal.Reader; every non-GET also needs the
      // CSRF header.
      api.addHook('preHandler', async (request) => {
        if (!request.session) throw unauthenticated();
        if (!isSafeMethod(request.method)) assertCsrf(request);
        const method = request.method === 'HEAD' ? 'GET' : request.method;
        if (!READER_EXEMPT.has(`${method} ${request.routeOptions.url}`))
          requireRole(request.session, 'Portal.Reader', 'Using AdminForge');
      });
      meRoutes(api, ctx);
      navRoutes(api, ctx);
      overviewRoutes(api, ctx);
      // Content & platform: definitions, datasources, search, capabilities, views, export, events, audit, appearance.
      contentRoutes(api, ctx);
      // Runs & approvals (playbook engine).
      runRoutes(api, ctx, runs);
      approvalRoutes(api, ctx, runs, schedules);
      // Schedules, probes, report artifacts and Query Studio (R6, R12).
      scheduleRoutes(api, ctx, schedules);
      // The Reports catalogue (every report, its params, export and schedules).
      reportCatalogRoutes(api, ctx, schedules);
      probeRoutes(api, ctx, schedules);
      // News and changes (feeds collected by the scheduler's news job).
      newsRoutes(api, ctx, schedules);
      queryRoutes(api, ctx);
    },
    { prefix: '/api' },
  );

  const serveSpa = webDistAvailable(config);
  if (serveSpa) {
    await app.register(fastifyStatic, {
      root: config.WEB_DIST_DIR,
      setHeaders: (reply, filePath) => {
        // Vite fingerprints everything under assets/; index.html must always be revalidated.
        if (/[\\/]assets[\\/]/.test(filePath))
          reply.header('cache-control', 'public, max-age=31536000, immutable');
        else reply.header('cache-control', 'no-cache');
      },
    });
  }

  app.setNotFoundHandler(async (request, reply) => {
    const pathname = request.url.split(/[?#]/)[0]!;
    // Client routes only (page keys contain dots, e.g. /p/identity.users); a missing asset gets a 404, not index.html.
    const isPage =
      (request.method === 'GET' || request.method === 'HEAD') &&
      !API_OR_AUTH.test(pathname) &&
      !NO_STORE.test(pathname) &&
      !STATIC_ASSET.test(pathname);
    if (serveSpa && isPage) {
      // SPA fallback: client-side routes (e.g. /p/identity.users) get index.html.
      return reply.header('cache-control', 'no-cache').sendFile('index.html');
    }
    return sendError(
      request,
      reply,
      new AppError(404, 'not_found', `No route for ${request.method} ${request.url.split('?')[0]}.`),
    );
  });

  return app;
}
