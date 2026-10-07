import type { SellerStatus } from '@/generated/prisma/client';

export async function PATCH(request: Request) {
  const body = (await request.json()) as { status?: SellerStatus; isActive?: boolean };
  return Response.json(body);
}
