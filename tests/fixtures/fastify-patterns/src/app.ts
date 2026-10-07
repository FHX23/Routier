import path from 'node:path';
import fastifyAutoload from '@fastify/autoload';
import type { FastifyInstance } from 'fastify';

export default async function serviceApp(fastify: FastifyInstance) {
  fastify.register(fastifyAutoload, {
    dir: path.join(import.meta.dirname, 'routes'),
    autoHooks: true,
    cascadeHooks: true,
  });
}
