function normalizedIdentityExpression(field) {
  return { $toLower: { $trim: { input: { $convert: { input: `$${field}`, to: "string", onNull: "", onError: "" } } } } };
}

// Only identities already normalized/validated by the CSV controller enter here.
// Database unique indexes are still required to prevent concurrent insert races.
async function importIdentityRows({ model, field, documents, merchantId, dataType, fileName }) {
  const totalRows = documents.length;
  const title = dataType === "customers" ? "Customer" : "Product";
  const makeResult = (statusCode, message, counts, errors = []) => ({ statusCode, body: {
    message, dataType, fileName, totalRows, importedCount: 0, skippedCount: 0,
    failedCount: 0, unconfirmedCount: 0, ...counts, errors
  } });
  let existing;
  try {
    existing = await model.aggregate([
      { $match: { merchantId } },
      { $project: { _id: 0, identity: normalizedIdentityExpression(field) } },
      { $match: { identity: { $in: documents.map((row) => row[field]) } } }
    ]);
  } catch {
    return makeResult(503, `${title} import could not start. This request wrote no rows. Preview again before retrying.`,
      { failedCount: totalRows }, [{ row: 1, column: "file", message: "Existing records could not be checked." }]);
  }
  const existingKeys = new Set(existing.map((row) => row.identity).filter(Boolean));
  const pending = documents.map((document, index) => ({ document, row: index + 2 }))
    .filter(({ document }) => !existingKeys.has(document[field]));
  const initialSkips = totalRows - pending.length;
  if (!pending.length) return makeResult(200, `No new ${dataType} were imported.`, { skippedCount: totalRows });

  const now = new Date();
  const operations = pending.map(({ document }) => ({ updateOne: {
    filter: { merchantId, [field]: document[field] },
    // A concurrent match must not change an existing profile or its timestamps.
    update: { $setOnInsert: { ...document, merchantId, createdAt: now, updatedAt: now } },
    upsert: true, timestamps: false
  } }));
  let result;
  let failure;
  try {
    result = await model.bulkWrite(operations, { ordered: false, throwOnValidationError: true });
  } catch (error) {
    failure = error;
    result = error?.result;
  }
  const rawErrors = Array.isArray(failure?.writeErrors) ? failure.writeErrors : [];
  const validErrors = rawErrors.length > 0 && rawErrors.every((error) => Number.isInteger(error.index) &&
    error.index >= 0 && error.index < pending.length && Number.isInteger(error.code)) &&
    new Set(rawErrors.map((error) => error.index)).size === rawErrors.length;
  const concernFailure = failure?.code === 64 || failure?.name === "MongoWriteConcernError" ||
    (typeof result?.getWriteConcernError === "function" && Boolean(result.getWriteConcernError())) ||
    Boolean(failure?.writeConcernErrors?.length);
  const validCount = (value) => Number.isInteger(value) && value >= 0 && value <= pending.length;
  const trustworthy = !concernFailure && (!failure || validErrors) && result?.acknowledged !== false &&
    validCount(result?.upsertedCount) && validCount(result?.matchedCount) &&
    result.upsertedCount + result.matchedCount + (validErrors ? rawErrors.length : 0) === pending.length;
  const importedCount = trustworthy ? result.upsertedCount : 0;
  let skippedCount = initialSkips + (trustworthy ? result.matchedCount : 0);
  const errors = [];
  let failedCount = 0;

  if (trustworthy && validErrors) {
    const duplicateErrors = rawErrors.filter((error) => error.code === 11000);
    let confirmedKeys = new Set();
    if (duplicateErrors.length) {
      try {
        const found = await model.find({ merchantId, [field]: {
          $in: duplicateErrors.map((error) => pending[error.index].document[field])
        } }, { _id: 0, [field]: 1 }).lean();
        confirmedKeys = new Set(found.map((row) => row[field]));
      } catch { /* A failed confirmation cannot turn a write error into a skip. */ }
    }
    for (const error of rawErrors) {
      const entry = pending[error.index];
      if (error.code === 11000 && confirmedKeys.has(entry.document[field])) {
        skippedCount += 1;
      } else {
        failedCount += 1;
        errors.push({ row: entry.row, column: field === "handle" ? "name" : "email", message: error.code === 11000
          ? "A write conflict occurred but the matching record could not be confirmed. Preview again before retrying."
          : "This row could not be saved. Preview again before retrying." });
      }
    }
  }
  const unconfirmedCount = totalRows - importedCount - skippedCount - failedCount;
  const success = trustworthy && failedCount === 0 && unconfirmedCount === 0 &&
    (!failure || (validErrors && rawErrors.every((error) => error.code === 11000)));
  if (!success) {
    if (unconfirmedCount) errors.push({ row: 1, column: "file",
      message: `${unconfirmedCount} row outcomes could not be confirmed; those rows may already be saved. Preview again before retrying.` });
    return makeResult(503, `${title} import needs attention: ${importedCount} imported, ${skippedCount} skipped, ` +
      `${failedCount} failed, ${unconfirmedCount} unconfirmed. ` +
      (unconfirmedCount ? "Unconfirmed rows may already be saved. " : "") + "Preview again before retrying.",
    { importedCount, skippedCount, failedCount, unconfirmedCount }, errors);
  }
  return makeResult(200, importedCount > 0 ? `${title} import complete.` : `No new ${dataType} were imported.`,
    { importedCount, skippedCount });
}

module.exports = { normalizedIdentityExpression, importIdentityRows };
