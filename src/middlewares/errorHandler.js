const errorHandler = (err, req, res, next) => {
let error = Object.create(err);
    Object.assign(error, err);

  console.error(err);

  // Mongoose bad ObjectId
  if (err.name === 'CastError') {
    const message = `Resource not found`;
    error = new Error(message);
    error.statusCode = 404;
  }

  // Mongoose Duplicate Key (e.g. Email or Phone Number already exists)
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue)[0];
    const message = `An account with that ${field} already exists.`;
    error = new Error(message);
    error.statusCode = 400;
  }

  // Mongoose Validation Error (Missing required fields)
  if (err.name === 'ValidationError') {
    const message = Object.values(err.errors).map(val => val.message).join(', ');
    error = new Error(message);
    error.statusCode = 400;
  }

// 🚨 THE FIX: Hide detailed stack traces/messages from the public in production
      const isProduction = process.env.NODE_ENV === 'production';
      const responseMessage = isProduction && !error.statusCode 
        ? 'Internal Server Error' 
        : (error.message || 'Server Error');

      res.status(error.statusCode || 500).json({
        success: false,
        error: responseMessage,
      });
    };

module.exports = errorHandler;