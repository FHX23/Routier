import type { ProfileUpdate } from '@/types/profile';
import { requireUser } from '@/lib/session';

async function saveProfile(userId: string, data: ProfileUpdate) {
  return { userId, ...data };
}

export async function PUT(request: Request) {
  const user = await requireUser();
  const body = await request.json();
  return Response.json(await saveProfile(String(user), body));
}

export async function PATCH(request: Request) {
  const body = (await request.json()) as {
    nickname?: string;
    avatarUrl?: string;
  };
  return Response.json(body);
}
