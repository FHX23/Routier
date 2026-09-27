import { z } from 'zod';
import { auth } from '@/auth';

const routeContextSchema = z.object({ params: z.object({ postId: z.string() }) });
const postPatchSchema = z.object({ title: z.string().min(3).optional(), content: z.any().optional() });

async function verifyAccess(postId: string) {
  const session = await auth();
  return Boolean(session && postId);
}

export async function PATCH(req: Request, context: z.infer<typeof routeContextSchema>) {
  const { params } = routeContextSchema.parse(context);
  if (!(await verifyAccess(params.postId))) return new Response(null, { status: 403 });
  const json = await req.json();
  const body = postPatchSchema.parse(json);
  return Response.json(body);
}
