export default async function (fastify: any) {
  fastify.get('/', async () => []);

  fastify.delete('/:id', async (request: any) => {
    const token = request.headers.authorization;
    return { token };
  });
}
