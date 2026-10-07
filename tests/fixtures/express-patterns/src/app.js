const express = require('express');
const passport = require('passport');
const rateLimit = require('express-rate-limit');
const routes = require('./routes');

const app = express();
const authLimiter = rateLimit({ max: 20 });

// Configuración, no protección de rutas.
app.use(passport.initialize());
app.use('/v1/auth', authLimiter);
app.options('*', (req, res) => res.sendStatus(204));

app.use('/v1', routes);

module.exports = app;
