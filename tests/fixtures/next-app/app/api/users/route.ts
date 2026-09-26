import { z } from 'zod';

const createUserSchema = z.object({
  name: z.string(),
  email: z.string().email(),
  role: z.enum(['admin', 'user']),
  meta: z.object({
    age: z.number()
  })
});

export async function POST(req: Request) {
  const auth = req.headers.get('Authorization');
  const custom = req.headers.get('X-Custom-Header');
  const body = await req.json();
  const data = createUserSchema.parse(body);
  return new Response(JSON.stringify(data));
}

export async function GET(req: Request) {
  const auth = req.headers.get('Authorization');
  return new Response('users list');
}
