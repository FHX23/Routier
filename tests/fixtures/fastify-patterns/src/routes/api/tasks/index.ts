import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { CreateTaskSchema, QueryTasksSchema } from '../../../schemas/tasks.js';

const plugin: FastifyPluginAsyncTypebox = async (fastify) => {
  fastify.get('/', { schema: { querystring: QueryTasksSchema } }, async (request) => request.query);

  fastify.post('/', { schema: { body: CreateTaskSchema } }, async (request) => request.body);

  fastify.post('/:id/upload', { schema: { consumes: ['multipart/form-data'] } }, async (request) => {
    const file = await request.file();
    return { name: file?.filename };
  });
};

export default plugin;
