import express from 'express';
import { z } from 'zod';

const updatePostSchema = z.object({ title: z.string(), published: z.boolean() });

export const postsRouter = express.Router();

postsRouter.get('/', (req, res) => {
  const key = req.get('X-Api-Key');
  res.json({ key });
});

postsRouter.patch('/:id', async (req, res) => {
  const data = updatePostSchema.parse(req.body);
  res.json(data);
});
