// backend/src/middlewares/errorHandler.js
const errorHandler = (err, req, res, next) => {
  let statusCode = err.statusCode || 500;
  let message = err.message || 'Server Error';

  console.error('🔥 API Error:', err.message);

  // 1. Mongoose Bad ObjectId
  if (err.name === 'CastError') {
    statusCode = 404;
    message = 'Resource not found.';
  }

  // 2. Mongoose Duplicate Key Error (11000)
  if (err.code === 11000) {
    statusCode = 400;
    const field = err.keyValue ? Object.keys(err.keyValue)[0] : 'field';
    message = `An account or record with that ${field} already exists.`;
  }

  // 3. Mongoose Validation Error
  if (err.name === 'ValidationError' && err.errors) {
    statusCode = 400;
    message = Object.values(err.errors)
      .map((val) => val.message)
      .join(', ');
  }

  // 4. Malformed JSON Payload in Request Body
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    statusCode = 400;
    message = 'Invalid JSON payload provided.';
  }

  // 5. JWT Errors
  if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
    statusCode = 401;
    message = 'Not authorized. Invalid or expired token.';
  }

  const isProduction = process.env.NODE_ENV === 'production';
  const safeResponseMessage =
    isProduction && statusCode === 500 ? 'Internal Server Error' : message;

  res.status(statusCode).json({
    success: false,
    error: safeResponseMessage,
  });
};

module.exports = errorHandler;