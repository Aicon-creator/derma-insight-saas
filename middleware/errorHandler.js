// middleware/errorHandler.js
module.exports = (err, req, res, next) => {
  console.error("ERROR:", err);
  const statusCode = err.statusCode || 500;
  const message = err.isOperational ? err.message : "Something went wrong.";
  res.status(statusCode).json({ message });
};