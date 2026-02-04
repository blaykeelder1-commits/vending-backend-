const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

function requestLogger(req, res, next) {
  req.correlationId = req.headers['x-correlation-id'] || uuidv4();
  res.setHeader('x-correlation-id', req.correlationId);

  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info('Request completed', {
      correlationId: req.correlationId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration,
    });
  });

  next();
}

module.exports = requestLogger;
