import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import { MongoClient } from 'mongodb';

// Configuration
const config = {
  storage: process.env.STORAGE_TYPE || 'file', // 'file' or 'mongodb'
  mongoUrl: process.env.MONGO_URL || 'mongodb://localhost:27017',
  mongoDb: process.env.MONGO_DB || 'nostr',
  mongoCollection: process.env.MONGO_COLLECTION || 'relay_lists',
  relays: process.env.RELAYS ? process.env.RELAYS.split(',') : ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.ditto.pub']
};

// MongoDB setup
let mongoClient;
let relayListCollection;

async function connectToMongo () {
  if (config.storage === 'mongodb') {
    try {
      mongoClient = new MongoClient(config.mongoUrl);
      await mongoClient.connect();
      console.log('Connected to MongoDB');

      const db = mongoClient.db(config.mongoDb);
      relayListCollection = db.collection(config.mongoCollection);

      // Create index on pubkey for faster lookups
      await relayListCollection.createIndex({ pubkey: 1 }, { unique: true });
    } catch (error) {
      console.error('MongoDB connection error:', error);
      process.exit(1);
    }
  }
}

// Save relay list function
async function saveRelayList (event) {
  const pubkey = event.pubkey;

  if (config.storage === 'file') {
    // Ensure data directory exists
    const dataDir = './data';
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // Save relay list to file
    const filePath = path.join(dataDir, `${pubkey}_relays.json`);
    fs.writeFileSync(filePath, JSON.stringify(event, null, 2));
    console.log(`Saved relay list for ${pubkey} to file`);
  }
  else if (config.storage === 'mongodb') {
    try {
      // Update or insert the relay list
      await relayListCollection.updateOne(
        { pubkey: pubkey },
        { $set: event },
        { upsert: true }
      );
      console.log(`Saved relay list for ${pubkey} to MongoDB`);
    } catch (error) {
      console.error(`Error saving relay list to MongoDB:`, error);
    }
  }
}

// Function to connect to a single relay
function connectToRelay (relayUrl) {
  const ws = new WebSocket(relayUrl);

  ws.on('open', () => {
    console.log(`Connected to Nostr relay: ${relayUrl}`);
    const req = ["REQ", `relay-list-firehose-${relayUrl}`, { kinds: [10002] }];
    ws.send(JSON.stringify(req));
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg[0] === 'EVENT' && msg[2]?.kind === 10002) {
        const event = msg[2];
        // Pretty print the event
        console.log(`\nReceived relay list from ${relayUrl}:`);
        console.log(JSON.stringify(event, null, 2));
        console.log('-------------------------------------');

        saveRelayList(event);
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

  console.log(`Connected to ${connections.length} relays: ${config.relays.join(', ')}`);

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

