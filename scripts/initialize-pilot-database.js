const { parseArgs } = require("node:util");
const mongoose = require("mongoose");
const { connectionSettings } = require("./lib/database-access");

// Explicitly initialize a NEW, EMPTY pilot/test database. Never run application
// model initialization against the existing demo database to build constraints.
async function initializePilotDatabase(db, models, confirmed) {
  if (!confirmed || !/^derma_insight_(?:pilot|shopify_test)_[a-zA-Z0-9_]+$/.test(db.databaseName)) {
    throw new Error("NEW_EMPTY_TARGET_REQUIRED");
  }
  const hello = await db.command({ hello: 1 });
  if (!hello.setName && hello.msg !== "isdbgrid") throw new Error("TRANSACTION_TARGET_REQUIRED");
  const collections = await db.listCollections({}, { nameOnly: true }).toArray();
  for (const info of collections) {
    if (await db.collection(info.name).findOne({}, { projection: { _id: 1 }, maxTimeMS: 10000 })) throw new Error("TARGET_NOT_EMPTY");
  }
  const names = new Set(collections.map(c => c.name));
  for (const model of models) {
    const name = model.collection.collectionName;
    if (!names.has(name)) await db.createCollection(name);
    const indexes = model.schema.indexes().map(([key, options]) => ({ key, ...options }));
    if (indexes.length) await db.collection(name).createIndexes(indexes);
  }
  return { status: "INITIALIZED", existingRecordsChanged: false, database: db.databaseName, collections: models.map(m => m.collection.collectionName) };
}

async function main() {
  let client;
  try {
    const { values } = parseArgs({ options: { database: { type: "string" }, "env-file": { type: "string" }, "confirm-empty": { type: "boolean" } } });
    if (!values["env-file"] || !values["confirm-empty"] || !/^derma_insight_(?:pilot|shopify_test)_[a-zA-Z0-9_]+$/.test(values.database || "")) throw new Error("NEW_EMPTY_TARGET_REQUIRED");
    const settings = connectionSettings(values);
    client = new mongoose.mongo.MongoClient(settings.uri, { serverSelectionTimeoutMS: 10000, connectTimeoutMS: 10000, socketTimeoutMS: 20000 });
    await client.connect();
    const models = ["Merchant", "Customer", "Product", "Event", "ShopifyOrder"].map(name => require(`../models/${name}`));
    console.log(JSON.stringify(await initializePilotDatabase(client.db(settings.database), models, true), null, 2));
  } catch (error) {
    const known = ["NEW_EMPTY_TARGET_REQUIRED", "TRANSACTION_TARGET_REQUIRED", "TARGET_NOT_EMPTY"];
    console.log(JSON.stringify({ status: "ERROR", code: known.includes(error.message) ? error.message : "INITIALIZATION_FAILED",
      message: "Use a fresh, empty, isolated pilot/test target and restricted credentials. No existing documents are updated or deleted. Index creation may be incomplete after a failure; keep the target empty and retry." }, null, 2));
    process.exitCode = 1;
  } finally { if (client) await client.close().catch(() => {}); }
}

if (require.main === module) main();
module.exports = { initializePilotDatabase };
