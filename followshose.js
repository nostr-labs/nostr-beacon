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
  relays: process.env.RELAYS ? process.env.RELAYS.split(',') : ['wss://relay.damus.io', 'wss://nos.lol', 'wss://ditto.pub/relay']
};

// MongoDB setup
let mongoClient;
let followsCollection;

async function connectToMongo () {
  if (config.storage === 'mongodb') {
    try {
      mongoClient = new MongoClient(config.mongoUrl);
      await mongoClient.connect();
      console.log('Connected to MongoDB');

      const db = mongoClient.db(config.mongoDb);
      followsCollection = db.collection(config.mongoCollection);

      // Create compound index for better query performance
      await followsCollection.createIndex({ pubkey: 1 }, { unique: true });
      await followsCollection.createIndex({ 'follows': 1 }); // For reverse lookups
      await followsCollection.createIndex({ created_at: -1 }); // For time-based queries
    } catch (error) {
      console.error('MongoDB connection error:', error);
      process.exit(1);
    }
  }
}

// Parse kind=3 content
function parseFollowList (event) {
  const followData = {
    pubkey: event.pubkey,
    follows: [],
    relays: {},
    created_at: event.created_at,
    event_id: event.id,
    sig: event.sig
  };

  // Parse tags for follows (p tags)
  if (event.tags && Array.isArray(event.tags)) {
    event.tags.forEach(tag => {
      if (tag[0] === 'p' && tag[1]) {
        // tag[1] is the followed pubkey
        // tag[2] could be relay URL (optional)
        // tag[3] could be petname (optional)
        followData.follows.push({
          pubkey: tag[1],
          relay: tag[2] || null,
          petname: tag[3] || null
        });
      }
    });
  }

  // Parse content for relay list (if present)
  if (event.content) {
    try {
      const relayList = JSON.parse(event.content);
      followData.relays = relayList;
    } catch (e) {
      // Content might not be JSON or might be empty
      console.log(`Could not parse content as relay list for ${event.pubkey}`);
    }
  }

  // Statistics for DID-Nostr
  followData.followsCount = followData.follows.length;
  
  // Generate DID identifiers for follows (for DID-Nostr spec)
  followData.followsDids = followData.follows.map(f => `did:nostr:${f.pubkey}`);

  return followData;
}

// Save follow list function
async function saveFollowList (event) {
  const followData = parseFollowList(event);
  const pubkey = event.pubkey;

  if (config.storage === 'file') {
    // Ensure data directory exists
    const dataDir = './data';
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // Save follow list to file
    const filePath = path.join(dataDir, `${pubkey}_follows.json`);
    fs.writeFileSync(filePath, JSON.stringify({
      ...followData,
      originalEvent: event
    }, null, 2));
    console.log(`Saved follow list for ${pubkey} (${followData.followsCount} follows) to file`);
  }
  else if (config.storage === 'mongodb') {
    try {
      // Update or insert the follow list
      await followsCollection.updateOne(
        { pubkey: pubkey },
        { 
          $set: {
            ...followData,
            originalEvent: event,
            updatedAt: new Date()
          }
        },
        { upsert: true }
      );
      console.log(`Saved follow list for ${pubkey} (${followData.followsCount} follows) to MongoDB`);
    } catch (error) {
      console.error(`Error saving follow list to MongoDB:`, error);
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
        const followData = parseFollowList(event);
        console.log(`\nReceived follow list from ${relayUrl}:`);
        console.log(`  Pubkey: ${event.pubkey}`);
        console.log(`  DID: did:nostr:${event.pubkey}`);
        console.log(`  Follows: ${followData.followsCount} users`);
        console.log(`  Relays: ${Object.keys(followData.relays).length} relays`);
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