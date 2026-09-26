import { z } from 'zod';

const authorSchema = z.object({
  id: z.uuid(),
});

export const updatePostSchema = z
  .object({
    title: z.string().min(1),
    tags: z.array(z.object({ name: z.string() })),
    email: z.email(),
    status: z.enum(['draft', 'published']).default('draft'),
    rating: z.number().int().optional(),
    author: authorSchema,
    website: z.url().nullable(),
  })
  .strict();
