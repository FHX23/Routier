import { z } from 'zod';

export const createUserSchema = z.object({
  email: z.email(),
  name: z.string(),
  admin: z.boolean().default(false),
});
