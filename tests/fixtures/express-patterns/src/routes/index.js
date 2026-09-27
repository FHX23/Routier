const express = require('express');
const authRoute = require('./auth.route');
const articlesRouter = require('./articles.route');

const router = express.Router();

// Montaje desde un array recorrido con forEach.
const defaultRoutes = [
  { path: '/auth', route: authRoute },
  { path: '/articles', route: articlesRouter },
];

defaultRoutes.forEach((route) => {
  router.use(route.path, route.route);
});

module.exports = router;
