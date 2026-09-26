import type { FastifyPluginAsync } from 'fastify';

const createUserBody = {
  type: 'object',
  required: ['email'],
  properties: {
    email: { type: 'string', format: 'email' },
    age: { type: 'integer' },
  },
} as const;

const usersRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', {
    schema: { querystring: { type: 'object', properties: { page: { type: 'integer' } } } },
  }, async () => []);

  fastify.post('/', { schema: { body: createUserBody } }, async (request, reply) => {
    return reply.code(201).send(request.body);
  });

  fastify.route({
    method: ['PUT', 'PATCH'],
    url: '/:id',
    preHandler: [fastify.authenticate],
    handler: async (request) => ({ id: request.params.id }),
  });
};

export default usersRoutes;
