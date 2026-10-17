const fs = require("node:fs");

const fields = ["documentCount", "documentsSha256", "indexesSha256", "optionsSha256"];

function validManifest(manifest) {
  return manifest?.version === 1 && manifest.type === "derma-insight-recovery-manifest" &&
    manifest.consistency === "operator-confirmed-writes-paused" && manifest.readOnly === true &&
    /^[a-f0-9]{64}$/.test(manifest.targetFingerprint) &&
    manifest.collections && typeof manifest.collections === "object" && !Array.isArray(manifest.collections) &&
    Object.keys(manifest.collections).length > 0 &&
    Object.values(manifest.collections).every((value) => value && Number.isSafeInteger(value.documentCount) && value.documentCount >= 0 &&
      fields.slice(1).every((field) => /^[a-f0-9]{64}$/.test(value[field])));
}

function compareManifests(source, restored) {
  if (!validManifest(source) || !validManifest(restored)) throw new Error("Invalid manifests");
  const differences = [];
  if (source.targetFingerprint === restored.targetFingerprint) differences.push({ check: "restoreConnectionFingerprintMustDiffer" });
  const names = [...new Set([...Object.keys(source.collections), ...Object.keys(restored.collections)])].sort();
  for (const collection of names) {
    const a = Object.hasOwn(source.collections, collection) ? source.collections[collection] : null;
    const b = Object.hasOwn(restored.collections, collection) ? restored.collections[collection] : null;
    if (!a || !b) differences.push({ collection, checks: ["collectionMissing"] });
    else {
      const checks = fields.filter((field) => a[field] !== b[field]);
      if (checks.length) differences.push({ collection, checks });
    }
  }
  return { version: 1, status: differences.length ? "MISMATCH" : "MATCH", readOnly: true,
    comparedCollections: names.length, differences,
    scope: "Compares supplied manifests only. Confirm target isolation independently; connection aliases can identify the same deployment. Backup scheduling, access controls and the live application are not verified." };
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2) throw new Error("Supply two manifest files");
    const result = compareManifests(...args.map((file) => JSON.parse(fs.readFileSync(file, "utf8"))));
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.status === "MATCH" ? 0 : 2;
  } catch {
    console.log(JSON.stringify({ status: "ERROR", message: "Supply valid source and restored manifest JSON files. No database was modified." }));
    process.exitCode = 1;
  }
}

module.exports = { compareManifests };
