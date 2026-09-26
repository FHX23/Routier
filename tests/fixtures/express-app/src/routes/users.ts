import { Router } from 'express';
import * as users from '../controllers/users.controller';
import { validate } from '../middleware/validate';
import { requireAuth } from '../middleware/auth';
import { createUserSchema } from '../schemas/user';

const router = Router();

router.get('/', users.list);
router.post('/', validate(createUserSchema), users.create);
router
  .route('/:id')
  .get(users.show)
  .delete(requireAuth, users.remove);

export default router;
