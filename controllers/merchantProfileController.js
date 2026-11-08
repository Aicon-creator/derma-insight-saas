const Merchant = require("../models/Merchant");
const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/AppError");

const editableFields = new Map([["businessName", 120], ["ownerName", 100]]);
const profileSelection = "businessName ownerName email platformType subscriptionTier";

// Never serialize a whole merchant document, including after a write.
function publicProfile(merchant) {
  return {
    _id: merchant._id,
    businessName: merchant.businessName,
    ownerName: merchant.ownerName,
    email: merchant.email,
    platformType: merchant.platformType,
    subscriptionTier: merchant.subscriptionTier
  };
}

function profileUpdates(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new AppError("Send a business name or owner name to update.", 400);
  }
  const entries = Object.entries(body);
  if (!entries.length || entries.some(([field]) => !editableFields.has(field))) {
    throw new AppError("Only business name and owner name can be updated here.", 400);
  }
  const updates = {};
  for (const [field, value] of entries) {
    const maximum = editableFields.get(field);
    const label = field === "businessName" ? "Business name" : "Owner name";
    if (typeof value !== "string" || !value.trim() || value.trim().length > maximum || /[\u0000-\u001f\u007f]/.test(value.trim())) {
      throw new AppError(`${label} must be between 1 and ${maximum} characters with no control characters.`, 400);
    }
    updates[field] = value.trim();
  }
  return updates;
}

const getProfile = (req, res) => {
  res.json({ message: "Merchant profile loaded", merchant: publicProfile(req.merchant) });
};

const updateProfile = asyncHandler(async (req, res) => {
  const updates = profileUpdates(req.body);
  let merchant;
  try {
    merchant = await Merchant.findOneAndUpdate(
      { _id: req.merchant._id },
      { $set: updates },
      { new: true, runValidators: true }
    ).select(profileSelection);
  } catch {
    // A write may have reached MongoDB before its acknowledgement was lost.
    // Do not claim it failed, or expose raw database errors/credentials.
    throw new AppError("We could not confirm your changes were saved. Reload your profile before trying again.", 503);
  }
  if (!merchant) throw new AppError("Merchant profile no longer exists. Please sign in again.", 404);
  res.json({ message: "Business profile saved", merchant: publicProfile(merchant) });
});

module.exports = { getProfile, updateProfile };
