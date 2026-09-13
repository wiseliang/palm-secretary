import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { KnowledgeStore, KnowledgeError } from './knowledge-store.js';

export function registerKnowledgeRoutes(app: FastifyInstance, root: string, authorize: (request: FastifyRequest, reply: FastifyReply) => boolean) {
  const store = new KnowledgeStore(root);
  app.register(async routes => {
    routes.addHook('preHandler', async (request, reply) => {
      reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
      if (!authorize(request, reply)) return reply;
    });
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof KnowledgeError) return reply.code(error.statusCode).send({ error: error.message });
      return reply.code(500).send({ error: '知识库暂时无法读取，请稍后重试' });
    });
    const query = (request: FastifyRequest, key: string, required = false) => {
      const value = (request.query as Record<string, unknown>)[key];
      if (value === undefined && !required) return '';
      if (typeof value !== 'string' || value.length > 1000 || (required && !value)) throw new KnowledgeError(400, '请求参数不正确');
      return value;
    };
    routes.get('/api/knowledge', request => store.list(query(request, 'q'), query(request, 'refresh') === '1'));
    routes.get('/api/knowledge/note', request => store.read(query(request, 'path', true)));
    routes.get('/api/knowledge/resolve', request => store.resolve(query(request, 'target', true), query(request, 'from')));
    routes.get('/api/knowledge/image', async (request, reply) => {
      const image = await store.image(query(request, 'target', true), query(request, 'from'));
      return reply.type(image.type).send(image.buffer);
    });
  });
}
