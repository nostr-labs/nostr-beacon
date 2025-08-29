import { MongoClient } from 'mongodb';

// Configuration
const config = {
  mongoUrl: process.env.MONGO_URL || 'mongodb://localhost:27017',
  mongoDb: process.env.MONGO_DB || 'nostr'
};

// Get relay URL from command line
const relayUrl = process.argv[2];

if (!relayUrl) {
  console.log('Usage: node addRelay.js <relay-url>');
  console.log('Example: node addRelay.js wss://relay.damus.io');
  process.exit(1);
}

// Canonicalize relay URL
function canonicalizeRelayUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.pathname === '' || parsed.pathname === '/') {
      return `${parsed.protocol}//${parsed.host}/`;
    }
    return url;
  } catch (e) {
    return url;
  }
}

async function addRelay() {
  const client = new MongoClient(config.mongoUrl);
  
  try {
    await client.connect();
    console.log('Connected to MongoDB');
    
    const db = client.db(config.mongoDb);
    const relaysCollection = db.collection('relays');
    
    const canonicalUrl = canonicalizeRelayUrl(relayUrl);
    
    // Try to insert the relay
    const result = await relaysCollection.updateOne(
      { relay: canonicalUrl },
      {
        $setOnInsert: {
          relay: canonicalUrl,
          addedAt: new Date(),
          online: null,
          responseTime: null,
          lastChecked: null,
          lastError: null,
          checksTotal: 0,
          checksOnline: 0
        }
      },
      { upsert: true }
    );
    
    if (result.upsertedCount > 0) {
      console.log(`✅ Added relay: ${canonicalUrl}`);
    } else {
      console.log(`ℹ️  Relay already exists: ${canonicalUrl}`);
    }
    
    // Show current relay count
    const totalRelays = await relaysCollection.countDocuments();
    console.log(`📊 Total relays in database: ${totalRelays}`);
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await client.close();
  }
}

addRelay();