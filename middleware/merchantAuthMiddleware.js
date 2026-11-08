const jwt = require("jsonwebtoken");
const Merchant = require("../models/Merchant");

const protectMerchant = async (req, res, next) => {
  try {
    let token;

    if (
      req.headers.authorization &&
      req.headers.authorization.startsWith("Bearer")
    ) {
      token = req.headers.authorization.split(" ")[1];
    }

    if (!token) {
      return res.status(401).json({
        message: "No token, authorization denied"
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });

    const merchant = await Merchant.findById(decoded.id).select("-password");

    if (!merchant) {
      return res.status(401).json({
        message: "Merchant not found"
      });
    }

    const tokenVersion = decoded.sv === undefined ? 0 : decoded.sv;
    const accountVersion = merchant.sessionVersion === undefined ? 0 : merchant.sessionVersion;
    if (!Number.isSafeInteger(tokenVersion) || tokenVersion < 0 || tokenVersion !== accountVersion) {
      return res.status(401).json({ message: "Your session has expired. Please sign in again." });
    }

    req.merchant = merchant;

    next();
  } catch (error) {
    console.error("MERCHANT AUTH ERROR:", error);
    res.status(401).json({
      message: "Merchant authentication failed"
    });
  }
};

module.exports = protectMerchant;
