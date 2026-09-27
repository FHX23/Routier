import { Router } from 'express';
import { auth } from '../middlewares/jwt';
import { createArticle, listArticles } from '../services/article.service';

// Router anónimo encadenado, exportado por defecto.
export default Router()
  .get('/', auth.optional, async (req, res) => {
    res.json(await listArticles(req.query));
  })
  .post('/', auth.required, async (req, res) => {
    res.json(await createArticle({ ...req.body.article, draft: false }));
  });
