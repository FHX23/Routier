const express = require('express');
const multer = require('multer');
const validate = require('../middlewares/validate');
const authValidation = require('../validations/auth.validation');
const auth = require('../middlewares/auth');

const upload = multer({ dest: 'uploads/' });
const router = express.Router();

router.post('/register', validate(authValidation.register), (req, res) => res.status(201).send(req.body));
router.post('/reset-password', validate(authValidation.resetPassword), (req, res) => res.send());
router.post('/avatar', auth(), upload.single('avatar'), (req, res) => res.send({ file: req.file, caption: req.body.caption }));

module.exports = router;
