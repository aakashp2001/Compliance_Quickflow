const { MongoClient } = require('mongodb');

let cachedClient = null;
let clientPromise = null;

function parseNumberEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw || String(raw).trim() === '') return fallback;
  const num = Number(raw);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

function getRequiredMongoUri() {
  const uri = String(process.env.MONGODB_URI || '').trim();
  if (!uri) {
    // throw new Error('Missing required env var MONGODB_URI');
    return 'mongodb://localhost:27017/';
  }
  return uri;
}

function getMongoDbName() {
  return String(process.env.MONGODB_DB_NAME || 'testhive').trim();
}

function buildMongoOptions() {
  return {
    appName: String(process.env.MONGODB_APP_NAME || 'TestHive-Backend').trim(),
    maxPoolSize: parseNumberEnv('MONGODB_MAX_POOL_SIZE', 10),
    minPoolSize: parseNumberEnv('MONGODB_MIN_POOL_SIZE', 0),
    maxIdleTimeMS: parseNumberEnv('MONGODB_MAX_IDLE_MS', 30000),
    connectTimeoutMS: parseNumberEnv('MONGODB_CONNECT_TIMEOUT_MS', 10000),
    serverSelectionTimeoutMS: parseNumberEnv('MONGODB_SERVER_SELECTION_TIMEOUT_MS', 10000),
    retryWrites: true,
  };
}

async function getMongoClient() {
  if (cachedClient) return cachedClient;
  if (!clientPromise) {
    const client = new MongoClient(getRequiredMongoUri(), buildMongoOptions());
    clientPromise = client.connect();
  }

  cachedClient = await clientPromise;
  return cachedClient;
}

async function getDb() {
  const client = await getMongoClient();
  return client.db(getMongoDbName());
}

async function closeMongoClient() {
  if (!cachedClient) return;
  await cachedClient.close();
  cachedClient = null;
  clientPromise = null;
}

module.exports = {
  getDb,
  getMongoClient,
  closeMongoClient,
};
