import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import { MongoClient } from 'mongodb';

// Configuration
const config = {
  storage: process.env.STORAGE_TYPE || 'file', // 'file' or 'mongodb'
  mongoUrl: process.env.MONGO_URL || 'mongodb://localhost:27017',
  mongoDb: process.env.MONGO_DB || 'nostr',
  mongoCollection: process.env.MONGO_FOLLOWS_COLLECTION || 'follows',
  relays: process.env.RELAYS ? process.env.RELAYS.split(',') : ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.ditto.pub']
};

// MongoDB setup
let mongoClient;
let followsCollection;
let relaysCollection;

async function connectToMongo () {
  if (config.storage === 'mongodb') {
    try {
      mongoClient = new MongoClient(config.mongoUrl);
      await mongoClient.connect();
      console.log('Connected to MongoDB');

      const db = mongoClient.db(config.mongoDb);
      followsCollection = db.collection(config.mongoCollection);
      relaysCollection = db.collection('relays'); // Simple collection for unique relay URLs

      // Create indexes for follows collection
      await followsCollection.createIndex({ pubkey: 1 }, { unique: true });
      await followsCollection.createIndex({ 'follows': 1 }); // For reverse lookups
      await followsCollection.createIndex({ created_at: -1 }); // For time-based queries

      // Create unique index for relays collection - just the relay URL
      await relaysCollection.createIndex({ relay: 1 }, { unique: true });
    } catch (error) {
      console.error('MongoDB connection error:', error);
      process.exit(1);
    }
  }
}

// Parse kind=3 content
function parseFollowList (event) {
  // Minimal follow data - just the graph essentials
  const followData = {
    pubkey: event.pubkey,
    follows: [], // Will store just pubkey strings
    created_at: event.created_at,
    count: 0 // Follow count for quick access
  };

  // Parse tags for follows (p tags) - store only pubkeys
  if (event.tags && Array.isArray(event.tags)) {
    event.tags.forEach(tag => {
      if (tag[0] === 'p' && tag[1]) {
        // Only store the pubkey, not relay or petname
        followData.follows.push(tag[1]);
      }
    });
  }

  followData.count = followData.follows.length;

  // Extract and canonicalize relay URLs (if present)
  let relayUrls = [];
  if (event.content) {
    try {
      const relayList = JSON.parse(event.content);
      relayUrls = Object.keys(relayList).map(canonicalizeRelayUrl);
    } catch (e) {
      // Content might not be JSON or might be empty
    }
  }

  return { followData, relayUrls };
}

// Canonicalize relay URLs - add trailing slash only to origins (no path)
function canonicalizeRelayUrl(url) {
  try {
    const parsed = new URL(url);
    // If the pathname is empty or just "/", ensure it ends with "/"
    if (parsed.pathname === '' || parsed.pathname === '/') {
      return `${parsed.protocol}//${parsed.host}/`;
    }
    // Otherwise, keep the path as-is
    return url;
  } catch (e) {
    // If URL parsing fails, return as-is
    return url;
  }
}

// Save follow list function
async function saveFollowList (event) {
  const { followData, relayUrls } = parseFollowList(event);
  const pubkey = event.pubkey;

  if (config.storage === 'file') {
    // Ensure data directory exists
    const dataDir = './data';
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // Save minimal follow list to file
    const filePath = path.join(dataDir, `${pubkey}_follows.json`);
    fs.writeFileSync(filePath, JSON.stringify(followData, null, 2));
    
    console.log(`Saved follow list for ${pubkey} (${followData.count} follows) to file`);
  }
  else if (config.storage === 'mongodb') {
    try {
      // Update or insert the minimal follow list
      await followsCollection.replaceOne(
        { pubkey: pubkey },
        followData,
        { upsert: true }
      );
      
      // Insert unique relay URLs (ignore duplicates)
      if (relayUrls.length > 0) {
        const relayDocs = relayUrls.map(url => ({ relay: url }));
        await relaysCollection.bulkWrite(
          relayDocs.map(doc => ({
            updateOne: {
              filter: { relay: doc.relay },
              update: { $setOnInsert: doc },
              upsert: true
            }
          })),
          { ordered: false }
        );
      }
      
      console.log(`Saved follow list for ${pubkey} (${followData.count} follows) to MongoDB`);
    } catch (error) {
      console.error(`Error saving to MongoDB:`, error);
    }
  }
}

// Function to connect to a single relay
function connectToRelay (relayUrl) {
  const ws = new WebSocket(relayUrl);

  ws.on('open', () => {
    console.log(`Connected to Nostr relay: ${relayUrl}`);
    // Request kind=3 (contact list) events
    const req = ["REQ", `follows-firehose-${relayUrl}`, { kinds: [3] }];
    ws.send(JSON.stringify(req));
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg[0] === 'EVENT' && msg[2]?.kind === 3) {
        const event = msg[2];
        // Parse and display summary
        const { followData, relayUrls } = parseFollowList(event);
        console.log(`\nReceived follow list from ${relayUrl}:`);
        console.log(`  Pubkey: ${event.pubkey.substring(0, 8)}...`);
        console.log(`  Follows: ${followData.count} users`);
        console.log(`  Relays: ${relayUrls.length} relays`);
        console.log(`  Timestamp: ${new Date(event.created_at * 1000).toISOString()}`);
        console.log('-------------------------------------');

        saveFollowList(event);
      }
    } catch (e) {
      console.error(`Error parsing message from ${relayUrl}:`, e);
    }
  });

  ws.on('error', (error) => {
    console.error(`WebSocket error on ${relayUrl}:`, error);
  });

  ws.on('close', () => {
    console.log(`Disconnected from ${relayUrl}, attempting to reconnect in 5 seconds...`);
    setTimeout(() => connectToRelay(relayUrl), 5000);
  });

  return ws;
}

// Initialize and connect to services
(async function init () {
  await connectToMongo();

  // Connect to all configured relays
  const connections = config.relays.map(relay => connectToRelay(relay));

  console.log(`Connected to ${connections.length} relays for kind=3 (follow lists): ${config.relays.join(', ')}`);
  console.log('Collecting follow data for DID-Nostr social graph...');

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    console.log('Shutting down...');
    if (mongoClient) await mongoClient.close();

    // Close all websocket connections
    connections.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    });

    process.exit(0);
  });
})();