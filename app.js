// app.js
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");

const app = express();

app.use(helmet());
app.use(express.json());
app.use(
  cors({
    origin: process.env.CLIENT_ORIGIN || "http://127.0.0.1:5500",
  })
);
app.use(express.static("public"));

const authRoutes = require("./routes/authRoutes");
app.use("/api/auth", authRoutes);

const merchantAuthRoutes = require("./routes/merchantAuthRoutes");
app.use("/api/merchants/auth", merchantAuthRoutes);

const merchantRoutes = require("./routes/merchantRoutes");
app.use("/api/merchants", merchantRoutes);

const simRoutes = require("./routes/simRoutes");
app.use("/api/sim", simRoutes);

const analyticsRoutes = require("./routes/analyticsRoutes");
app.use("/api/analytics", analyticsRoutes);

const recommendationRoutes = require("./routes/recommendationRoutes");
app.use("/api/recommendations", recommendationRoutes);

const customerRoutes = require("./routes/customerRoutes");
app.use("/api/customers", customerRoutes);

const segmentRoutes = require("./routes/segmentRoutes");
app.use("/api/segments", segmentRoutes);

app.get("/", (req, res) => {
  res.send("Derma Insight SaaS API is running...");
});

const errorHandler = require("./middleware/errorHandler");
app.use(errorHandler);

module.exports = app;