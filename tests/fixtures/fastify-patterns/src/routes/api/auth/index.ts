import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { CredentialsSchema } from '../../../schemas/tasks.js';

const plugin: FastifyPluginAsyncTypebox = async (fastify) => {
  fastify.post('/login', { schema: { body: CredentialsSchema } }, async (request) => {
    // Asignar la sesión (login) no es exigirla.
    request.session.user = { email: request.body.email };
    return { ok: true };
  });
};

export default plugin;
