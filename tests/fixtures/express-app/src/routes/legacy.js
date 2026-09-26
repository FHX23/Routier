const express = require('express');

const router = express.Router();

router.get('/items', function (req, res) {
  res.json([]);
});

module.exports = router;
