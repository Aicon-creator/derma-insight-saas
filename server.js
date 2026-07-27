// server.js
const path = require("path");
const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

dotenv.config();

const app = express();

/*
 * Render and similar platforms run the application behind a proxy.
 * This allows Express to read the original client IP correctly.
 */
if (process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

/*
 * Security headers.
 *
 * CSP is temporarily disabled because the current frontend may use
 * inline scripts/styles or externally hosted libraries such as Chart.js.
 * We can configure a strict CSP after the first stable deployment.
 */
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
  })
);

app.use(
  express.json({
    limit: "1mb"
  })
);

/*
 * Allow the local frontend during development and the deployed frontend
 * through CLIENT_ORIGIN in production.
 */
const allowedOrigins = [
  "http://127.0.0.1:5500",
  "http://localhost:5500",
  process.env.CLIENT_ORIGIN
].filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // Requests such as Postman, curl and server-to-server calls
      // may not include an Origin header.
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(
        new Error(`Origin ${origin} is not allowed by CORS`)
      );
    },
    credentials: true
  })
);

/*
 * Public health check.
 *
 * This is placed before the general API rate limiter so Render can
 * reliably verify that the service is healthy.
 */
app.get("/api/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    message: "Derma Insight API is running",
    environment: process.env.NODE_ENV || "development",
    timestamp: new Date().toISOString()
  });
});

/*
 * General API rate limit.
 *
 * This protects the API from accidental request loops and basic abuse.
 * We can add a stricter login-specific limiter later.
 */
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: "fail",
    message: "Too many requests. Please try again later."
  }
});

app.use("/api", apiLimiter);

/*
 * Serve the frontend from the public folder.
 *
 * This means we can deploy the frontend and backend together as one
 * Render service, which is the fastest deployment approach.
 */
const publicDirectory = path.join(__dirname, "public");
app.use(express.static(publicDirectory));

/*
 * API routes
 */
const authRoutes = require("./routes/authRoutes");
const merchantAuthRoutes = require("./routes/merchantAuthRoutes");
const merchantRoutes = require("./routes/merchantRoutes");
const simRoutes = require("./routes/simRoutes");
const analyticsRoutes = require("./routes/analyticsRoutes");
const recommendationRoutes = require("./routes/recommendationRoutes");
const customerRoutes = require("./routes/customerRoutes");
const segmentRoutes = require("./routes/segmentRoutes");
const shopifyRoutes = require("./routes/shopifyRoutes");

app.use("/api/auth", authRoutes);
app.use("/api/merchants/auth", merchantAuthRoutes);
app.use("/api/merchants", merchantRoutes);
app.use("/api/sim", simRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/recommendations", recommendationRoutes);
app.use("/api/customers", customerRoutes);
app.use("/api/segments", segmentRoutes);
app.use("/api/shopify", shopifyRoutes);

/*
 * API information endpoint.
 *
 * GET / will normally serve public/index.html because express.static()
 * is registered above.
 */
app.get("/api", (req, res) => {
  res.status(200).json({
    name: "Derma Insight SaaS API",
    status: "running"
  });
});

/*
 * Final 404 handler.
 *
 * This only runs when neither a static file nor an API route matched.
 */
app.use((req, res) => {
  res.status(404).json({
    status: "fail",
    message: `Route not found: ${req.originalUrl}`
  });
});

/*
 * Global error handler must remain last.
 */
const errorHandler = require("./middleware/errorHandler");
app.use(errorHandler);

/*
 * Start the real server only when this file is executed directly.
 * Test files can import the Express app without opening a port.
 */
async function startServer() {
  const requiredEnvVars = ["JWT_SECRET", "MONGO_URI"];

  const missingEnvVars = requiredEnvVars.filter(
    (key) => !process.env[key]
  );

  if (missingEnvVars.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missingEnvVars.join(", ")}`
    );
  }

  const connectDB = require("./config/db");

  // Do not accept requests until MongoDB is connected.
  await connectDB();

  const PORT = process.env.PORT || 5000;

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error("SERVER STARTUP ERROR:", error);
    process.exit(1);
  });
}

module.exports = app;