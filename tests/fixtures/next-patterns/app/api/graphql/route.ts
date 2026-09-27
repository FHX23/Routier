import { requireUser } from '@/lib/session';

const typeDefs = `
  scalar DateTime
  type Query { now(after: DateTime): DateTime }
`;

async function context() {
  return { user: await requireUser() };
}

export async function GET(request: Request) {
  return Response.json({ typeDefs, context, request });
}

export async function POST(request: Request) {
  return Response.json({ typeDefs, context, request });
}
