import Fastify from 'fastify';
import autoload from '@fastify/autoload';
import path from 'node:path';
import usersRoutes from './plugins/users';

const fastify = Fastify({ logger: true });

fastify.get('/health', async () => ({ ok: true }));

fastify.register(usersRoutes, { prefix: '/api/users' });

fastify.register(async (instance) => {
  instance.addHook('onRequest', instance.authenticate);

  instance.get('/stats', async (request) => {
    return { range: request.query.range };
  });
}, { prefix: '/admin' });

fastify.register(autoload, {
  dir: path.join(__dirname, 'routes'),
  options: { prefix: '/v1' },
});

fastify.listen({ port: 3000 });
