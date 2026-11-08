const recovery = require("../services/passwordRecovery");
const asyncHandler = require("../utils/asyncHandler");

const recoveryStatus = (req, res) => {
  res.json({ available: Boolean(recovery.configuration()) });
};

const forgotPassword = (req, res) => {
  const email = recovery.requestEmail(req.body);
  const config = recovery.requireConfiguration();
  res.status(202).json({ message: recovery.GENERIC_REQUEST_MESSAGE });
  recovery.requestReset(email, config);
};

const resetPassword = asyncHandler(async (req, res) => {
  const details = recovery.resetDetails(req.body);
  const config = recovery.requireConfiguration();
  const merchant = await recovery.completeReset(details);
  res.json({ message: "Password changed. Please sign in with your new password." });
  recovery.notifyPasswordChanged(merchant, config);
});

module.exports = { recoveryStatus, forgotPassword, resetPassword };
