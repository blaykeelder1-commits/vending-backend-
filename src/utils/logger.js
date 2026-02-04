const winston = require('winston');

const { combine, timestamp, printf, colorize, errors } = winston.format;

// Custom format for console output
const consoleFormat = printf(({ level, message, timestamp, stack, ...meta }) => {
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  if (stack) {
    return `${timestamp} [${level}]: ${message}\n${stack}${metaStr}`;
  }
  return `${timestamp} [${level}]: ${message}${metaStr}`;
});

// Custom format for file/production output (JSON)
const fileFormat = printf(({ level, message, timestamp, stack, ...meta }) => {
  const logObject = {
    timestamp,
    level,
    message,
    ...meta,
  };
  if (stack) {
    logObject.stack = stack;
  }
  return JSON.stringify(logObject);
});

// Determine log level based on environment
const getLogLevel = () => {
  const env = process.env.NODE_ENV || 'development';
  if (env === 'production') return 'info';
  if (env === 'test') return 'error';
  return 'debug';
};

// Create the logger
const logger = winston.createLogger({
  level: getLogLevel(),
  format: combine(
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    errors({ stack: true })
  ),
  defaultMeta: { service: 'iddi-backend' },
  transports: [],
});

// Console transport (development)
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: combine(
      colorize(),
      consoleFormat
    ),
  }));
} else {
  // Production: structured JSON logs to console (for Render/cloud)
  logger.add(new winston.transports.Console({
    format: fileFormat,
  }));
}

// Convenience methods that match common console.* patterns
logger.success = (message, meta = {}) => {
  logger.info(message, { status: 'success', ...meta });
};

// Export helper for request logging context
logger.withContext = (context) => {
  return {
    debug: (msg, meta = {}) => logger.debug(msg, { ...context, ...meta }),
    info: (msg, meta = {}) => logger.info(msg, { ...context, ...meta }),
    warn: (msg, meta = {}) => logger.warn(msg, { ...context, ...meta }),
    error: (msg, meta = {}) => logger.error(msg, { ...context, ...meta }),
  };
};

module.exports = logger;
