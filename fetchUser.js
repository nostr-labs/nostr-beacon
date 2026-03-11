#!/usr/bin/env node
import WebSocket from 'ws';
import { MongoClient } from 'mongodb';

// Configuration
const config = {
  mongoUrl: process.env.MONGO_URL || 'mongodb://localhost:27017',
  mongoDb: process.env.MONGO_DB || 'nostr',
  beaconCollection: process.env.MONGO_COLLECTION || 'beacon',
  followsCollection: process.env.MONGO_FOLLOWS_COLLECTION || 'follows',
  relays: process.env.RELAYS ? process.env.RELAYS.split(',') : [
    'wss://relay.damus.io',
    'wss://nos.lol', 
    'wss://relay.ditto.pub',
    'wss://relay.nostr.bg',
    'wss://nostr.wine',
    'wss://relay.snort.social'
  ]
};

// MongoDB setup
let mongoClient;
let beaconCollection;
let followsCollection;

async function connectToMongo() {
  try {
    mongoClient = new MongoClient(config.mongoUrl);
    await mongoClient.connect();
    console.log('Connected to MongoDB');

    const db = mongoClient.db(config.mongoDb);
    beaconCollection = db.collection(config.beaconCollection);
    followsCollection = db.collection(config.followsCollection);

    // Create indexes
    await beaconCollection.createIndex({ pubkey: 1 }, { unique: true });
    await followsCollection.createIndex({ pubkey: 1 }, { unique: true });
  } catch (error) {
    console.error('MongoDB connection error:', error);
    process.exit(1);
  }
}

// Save profile to database
async function saveProfile(event) {
  try {
    let content;
    try {
      content = JSON.parse(event.content);
    } catch (e) {
      console.log(`Invalid JSON in profile for ${event.pubkey}`);
      content = {};
    }

    const profile = {
      pubkey: event.pubkey,
      name: content.name || '',
      about: content.about || '',
      picture: content.picture || '',
      banner: content.banner || '',
      nip05: content.nip05 || '',
      lud06: content.lud06 || '',
      lud16: content.lud16 || '',
      display_name: content.display_name || content.displayName || '',
      website: content.website || '',
      created_at: event.created_at,
      event_id: event.id,
      sig: event.sig,
      content: event.content
    };

    await beaconCollection.replaceOne(
      { pubkey: event.pubkey },
      profile,
      { upsert: true }
    );

    console.log(`✓ Saved profile for ${event.pubkey} (${profile.name || 'unnamed'})`);
    return true;
  } catch (error) {
    console.error(`Error saving profile for ${event.pubkey}:`, error);
    return false;
  }
}

// Parse and save follows list
async function saveFollowsList(event) {
  try {
    const followData = {
      pubkey: event.pubkey,
      follows: [],
      relays: {},
      created_at: event.created_at,
      event_id: event.id,
      sig: event.sig,
      originalEvent: event
    };

    // Parse p-tags for follows
    event.tags.forEach(tag => {
      if (tag[0] === 'p' && tag[1]) {
        const follow = {
          pubkey: tag[1],
          relay: tag[2] || '',
          petname: tag[3] || ''
        };
        followData.follows.push(follow);
      }
    });

    // Parse relay preferences from content
    if (event.content) {
      try {
        const relayData = JSON.parse(event.content);
        followData.relays = relayData;
      } catch (e) {
        // Content might not be JSON, that's ok
      }
    }

    // Add counts and DID format
    followData.followsCount = followData.follows.length;
    followData.followsDids = followData.follows.map(f => `did:nostr:${f.pubkey}`);

    await followsCollection.replaceOne(
      { pubkey: event.pubkey },
      followData,
      { upsert: true }
    );

    console.log(`✓ Saved follows list for ${event.pubkey} (${followData.followsCount} follows)`);
    return true;
  } catch (error) {
    console.error(`Error saving follows for ${event.pubkey}:`, error);
    return false;
  }
}

// Connect to relay and fetch data
async function fetchFromRelay(relayUrl, pubkey, timeout = 10000) {
  return new Promise((resolve) => {
    const ws = new WebSocket(relayUrl);
    const results = { profile: null, follows: null };
    let profileReceived = false;
    let followsReceived = false;
    
    const timer = setTimeout(() => {
      ws.close();
      resolve(results);
    }, timeout);

    ws.on('open', () => {
      console.log(`📡 Connected to ${relayUrl}`);
      
      // Request profile (kind 0)
      const profileReq = JSON.stringify([
        'REQ', 
        'profile-' + Math.random().toString(36).substr(2, 9),
        {
          authors: [pubkey],
          kinds: [0],
          limit: 1
        }
      ]);
      ws.send(profileReq);

      // Request follows (kind 3)  
      const followsReq = JSON.stringify([
        'REQ',
        'follows-' + Math.random().toString(36).substr(2, 9), 
        {
          authors: [pubkey],
          kinds: [3],
          limit: 1
        }
      ]);
      ws.send(followsReq);
    });

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data);
        
        if (message[0] === 'EVENT') {
          const event = message[2];
          
          if (event.kind === 0 && !profileReceived) {
            results.profile = event;
            profileReceived = true;
            console.log(`📄 Found profile on ${relayUrl}`);
          }
          
          if (event.kind === 3 && !followsReceived) {
            results.follows = event;
            followsReceived = true;
            console.log(`👥 Found follows on ${relayUrl}`);
          }

          // Close if we have both
          if (profileReceived && followsReceived) {
            clearTimeout(timer);
            ws.close();
            resolve(results);
          }
        }
        
        if (message[0] === 'EOSE') {
          // End of stored events - close after a brief wait
          setTimeout(() => {
            clearTimeout(timer);
            ws.close();
            resolve(results);
          }, 500);
        }
      } catch (error) {
        console.error(`Error parsing message from ${relayUrl}:`, error);
      }
    });

    ws.on('error', (error) => {
      console.error(`❌ Error connecting to ${relayUrl}:`, error.message);
      clearTimeout(timer);
      resolve(results);
    });

    ws.on('close', () => {
      console.log(`🔌 Disconnected from ${relayUrl}`);
      clearTimeout(timer);
      resolve(results);
    });
  });
}

// Main function
async function fetchUserData(pubkey) {
  console.log(`🔍 Fetching data for pubkey: ${pubkey}`);
  console.log(`📡 Checking ${config.relays.length} relays...`);

  await connectToMongo();

  let foundProfile = false;
  let foundFollows = false;

  // Try each relay
  for (const relay of config.relays) {
    if (foundProfile && foundFollows) break;
    
    try {
      const results = await fetchFromRelay(relay, pubkey);
      
      if (results.profile && !foundProfile) {
        const saved = await saveProfile(results.profile);
        if (saved) foundProfile = true;
      }
      
      if (results.follows && !foundFollows) {
        const saved = await saveFollowsList(results.follows);
        if (saved) foundFollows = true;
      }
    } catch (error) {
      console.error(`Error with relay ${relay}:`, error);
    }
  }

  // Summary
  console.log('\n📊 Summary:');
  console.log(`Profile: ${foundProfile ? '✓ Found and saved' : '❌ Not found'}`);
  console.log(`Follows: ${foundFollows ? '✓ Found and saved' : '❌ Not found'}`);

  await mongoClient?.close();
  console.log('🏁 Done!');
}

// CLI interface
const pubkey = process.argv[2];
if (!pubkey) {
  console.error('Usage: node fetchUser.js <pubkey>');
  console.error('Example: node fetchUser.js 3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d');
  process.exit(1);
}

if (pubkey.length !== 64) {
  console.error('Error: pubkey must be 64 characters (hex format)');
  process.exit(1);
}

fetchUserData(pubkey).catch(console.error);