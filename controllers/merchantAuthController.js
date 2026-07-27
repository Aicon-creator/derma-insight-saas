// controllers/merchantAuthController.js
const Merchant = require("../models/Merchant");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/AppError");

const generateToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: "7d" });

const registerMerchant = asyncHandler(async (req, res) => {
  const { businessName, ownerName, email, password } = req.body;

  if (!businessName || !ownerName || !email || !password) {
    throw new AppError("All fields are required", 400);
  }

  if (password.length < 8) {
    throw new AppError("Password must be at least 8 characters", 400);
  }

  const exists = await Merchant.findOne({ email });
  if (exists) {
    throw new AppError("Merchant already exists", 400);
  }

  const newMerchant = await Merchant.create({
    businessName,
    ownerName,
    email,
    password,
  });

  res.status(201).json({
    _id: newMerchant._id,
    businessName: newMerchant.businessName,
    ownerName: newMerchant.ownerName,
    email: newMerchant.email,
    token: generateToken(newMerchant._id),
  });
});

const loginMerchant = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  const foundMerchant = await Merchant.findOne({ email });
  const isMatch = foundMerchant
    ? await bcrypt.compare(password, foundMerchant.password)
    : false;

  if (!foundMerchant || !isMatch) {
    throw new AppError("Invalid credentials", 400);
  }

  res.json({
    _id: foundMerchant._id,
    businessName: foundMerchant.businessName,
    ownerName: foundMerchant.ownerName,
    email: foundMerchant.email,
    token: generateToken(foundMerchant._id),
  });
});

module.exports = { registerMerchant, loginMerchant };