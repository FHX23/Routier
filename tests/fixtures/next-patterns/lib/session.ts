import { auth } from '@/auth';

// Dos helpers que se llaman entre sí: el detector no debe quedar esperando su propia promesa.
export async function requireUser() {
  const session = await auth();
  if (!session) throw new Error('Unauthorized');
  return ping(session);
}

export async function ping(value: unknown): Promise<unknown> {
  return value ? value : requireUser();
}
