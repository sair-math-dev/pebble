import Fastify, { type FastifyRequest } from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { publicKey, type Registry } from './registry.js';

const INDEX_PATH = /^\/index\/(config\.json|(?:[a-z0-9]{1,2}|3\/[a-z])\/[a-z][a-z0-9_-]{0,63}|[a-z0-9]{2}\/[a-z0-9]{2}\/[a-z][a-z0-9_-]{0,63})$/;
const STATIC_PATH = /^\/static\/(packages\/[a-z][a-z0-9_-]{0,63}\/[0-9A-Za-z.-]{1,64}\/[a-z][a-z0-9_-]{0,63}-[0-9A-Za-z.-]{1,64}\.(?:slatepkg|interface)|toolchains\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[a-z0-9_]+-[a-z0-9_]+\/(?:slatec|slate|slatec\.sha256|TOOLCHAIN\.lock))$/;

export function createServer(registry: Registry) {
  const trustedProxies = process.env.TRUST_PROXY_CIDRS?.split(',').map(value => value.trim()).filter(Boolean);
  const app = Fastify({ logger: {redact:['req.headers.authorization','req.headers.cookie']}, bodyLimit: 96 * 1024 * 1024, requestTimeout: 120_000, connectionTimeout: 10_000, trustProxy: trustedProxies?.length ? trustedProxies : false });
  app.register(helmet);
  app.register(rateLimit, {max:180,timeWindow:'1 minute'});
  let inFlight = 0;
  let heavyInFlight = 0;
  const admitted = new WeakMap<FastifyRequest,{
    heavy:boolean;handlerStarted:boolean;settled:boolean;transportEnded:boolean;
  }>();
  const release = (request:FastifyRequest) => {
    const admission = admitted.get(request);
    if (!admission || (admission.handlerStarted && !admission.settled)) return;
    admitted.delete(request);
    inFlight--;
    if (admission.heavy) heavyInFlight--;
  };
  const transportEnded = (request:FastifyRequest) => {
    const admission = admitted.get(request);
    if (!admission) return;
    admission.transportEnded = true;
    release(request);
  };
  app.addHook('onRequest',async (request,reply) => {
    const path = new URL(request.url,'http://registry.invalid').pathname;
    if (path === '/api/v1/invitations/redeem' && request.url.split('?')[0] !== path) {
      return reply.code(404).send({error:'not_found',message:'Route not found'});
    }
    if (path.startsWith('/health/')) return;
    // Archive uploads and archive reads hold object-store connections.
    const heavy = (request.method === 'PUT' && path === '/api/v1/packages/new')
      || (request.method === 'GET' && path.startsWith('/static/'));
    if (inFlight >= 64 || (heavy && heavyInFlight >= 4)) {
      return reply.code(503).header('Retry-After','1').send({error:'server_busy',message:'Request concurrency limit reached; retry shortly'});
    }
    admitted.set(request,{heavy,handlerStarted:false,settled:false,transportEnded:false});
    inFlight++; if (heavy) heavyInFlight++;
    // GET request bodies may already be complete when the client disconnects,
    // so IncomingMessage's aborted event alone does not cover this lifecycle.
    reply.raw.once('close',() => { transportEnded(request); });
  });
  app.addHook('onResponse',async request => { transportEnded(request); });
  app.addHook('onRequestAbort',async request => { transportEnded(request); });
  app.addHook('onTimeout',async request => { transportEnded(request); });
  app.addHook('onError',async (request,reply) => {
    // An ordinary handler error still has a response to serialize. Hold its
    // admission slot until onResponse, unless its connection is already gone.
    if (request.raw.aborted || reply.raw.destroyed) transportEnded(request);
  });
  const begin = (request:FastifyRequest) => {
    const admission = admitted.get(request);
    // A body may finish parsing just as its transport closes. Once its unused
    // slot has been returned, that abandoned request must never start work.
    if (!admission || admission.transportEnded) return null;
    admission.handlerStarted = true;
    return admission;
  };
  const settle = (request:FastifyRequest) => {
    const admission = admitted.get(request);
    if (!admission) return;
    admission.settled = true;
    // A disconnected client does not cancel S3 or database work. Keep the
    // capacity reserved until that work actually settles, even on errors.
    if (admission.transportEnded) release(request);
  };
  // Route hooks installed by helmet/rate-limit must exist before routes are
  // declared. Registering routes synchronously above the plugin boot sequence
  // leaves configuration present but the actual rate-limit hooks absent.
  app.register(async app => {
  app.get('/health/live', {config:{rateLimit:false}}, async () => ({ status: 'ok' }));
  app.get('/health/ready', {config:{rateLimit:false}}, async (_request, reply) => {
    try { await registry.db.pool.query('SELECT 1'); await registry.options.objectStore.healthy?.(); return { status: 'ready' }; }
    catch { return reply.code(503).send({ status: 'unavailable' }); }
  });
  app.post('/api/v1/invitations/redeem', {
    bodyLimit:1024,
    config:{rateLimit:{max:5,timeWindow:'1 minute',keyGenerator:(request:FastifyRequest) => request.ip}},
  }, async (request,reply) => {
    if (!begin(request)) { reply.raw.destroy(); return; }
    try {
      reply.header('Cache-Control','no-store');
      const result = await registry.request('POST','/api/v1/invitations/redeem',request.body);
      return reply.code(result.status).send(result.body);
    } finally { settle(request); }
  });
  // The public read tree (`public/index/...`, `public/packages/...`,
  // `public/toolchains/...`) for local runs and mirrors without static hosts.
  const readTree = async (request:FastifyRequest, reply:import('fastify').FastifyReply, key:string, contentType:string) => {
    if (!begin(request)) { reply.raw.destroy(); return; }
    try {
      let bytes: Buffer;
      try { bytes = await registry.options.objectStore.get(publicKey(key)); }
      catch (error) {
        if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return reply.code(404).send({error:'not_found',message:'No such file'});
        throw error;
      }
      return reply.header('Cache-Control', key.startsWith('index/') ? 'no-cache' : 'public, max-age=31536000, immutable').type(contentType).send(bytes);
    } finally { settle(request); }
  };
  app.get('/index/*', {config:{rateLimit:{max:600,timeWindow:'1 minute'}}}, async (request, reply) => {
    const path = new URL(request.url,'http://registry.invalid').pathname;
    const match = INDEX_PATH.exec(path);
    if (!match) return reply.code(404).send({error:'not_found',message:'No such index file'});
    return readTree(request, reply, 'index/' + match[1]!, match[1] === 'config.json' ? 'application/json' : 'text/plain; charset=utf-8');
  });
  app.get('/static/*', {config:{rateLimit:{max:600,timeWindow:'1 minute'}}}, async (request, reply) => {
    const path = new URL(request.url,'http://registry.invalid').pathname;
    const match = STATIC_PATH.exec(path);
    if (!match) return reply.code(404).send({error:'not_found',message:'No such file'});
    return readTree(request, reply, match[1]!, 'application/octet-stream');
  });
  app.route({ method: ['GET','POST','PUT','DELETE'], url: '/api/v1/*', config:{rateLimit:{
    max:(request) => request.method === 'GET' ? 180 : 30,timeWindow:'1 minute',
    keyGenerator:(request) => `${request.ip}:${request.method === 'GET' ? 'read' : 'write'}`,
  }}, handler: async (request, reply) => {
    if (!begin(request)) { reply.raw.destroy(); return; }
    try {
      reply.header('Cache-Control','no-store');
      const auth = request.headers.authorization;
      if (auth && !/^Bearer [^\s]+$/.test(auth)) return reply.code(401).send({ error:'unauthorized',message:'Expected a bearer token' });
      const token = auth?.slice(7);
      const response = await registry.request(request.method, request.url, request.body ?? {}, token, {
        'idempotency-key': typeof request.headers['idempotency-key'] === 'string' ? request.headers['idempotency-key'] : undefined,
      });
      return reply.code(response.status).send(response.body);
    } finally { settle(request); }
  } });
  });
  app.setErrorHandler((error,request,reply) => {
    request.log.error(error);
    const details: Error & {statusCode?:number} = error instanceof Error ? error : new Error('Request failed');
    const status = typeof details.statusCode === 'number' && details.statusCode >= 400 && details.statusCode < 500 ? details.statusCode : 500;
    reply.code(status).send({error:status === 500 ? 'internal_error' : 'invalid_request',message:status === 500 ? 'Registry request failed' : details.message});
  });
  return app;
}
