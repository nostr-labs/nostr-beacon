import WebSocket from 'ws';
import { MongoClient } from 'mongodb';
import { generatePrivateKey, getPublicKey, getEventHash, getSignature } from 'nostr-tools';

// Configuration
const config = {
  mongoUrl: process.env.MONGO_URL || 'mongodb://localhost:27017',
  mongoDb: process.env.MONGO_DB || 'nostr',
  timeout: parseInt(process.env.TIMEOUT) || 8000, // 8 second timeout
  batchSize: parseInt(process.env.BATCH_SIZE) || 5, // Test 5 relays at a time
  topCount: parseInt(process.env.TOP_COUNT) || 50, // Test top 50 relays
  eventKind: parseInt(process.env.EVENT_KIND) || 1 // Default to kind 1 (text note)
};

// Generate a properly signed test event
function generateTestEvent() {
  // Generate a new keypair for testing
  const privateKey = generatePrivateKey();
  const publicKey = getPublicKey(privateKey);
  
  // Create an event (kind 1 is more widely accepted than ephemeral)
  const event = {
    kind: config.eventKind,
    pubkey: publicKey,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['t', 'test'],
      ['client', 'nostr-beacon'],
      ['expiration', String(Math.floor(Date.now() / 1000) + 60)] // Expires in 60 seconds
    ],
    content: `Test event from nostr-beacon relay monitor (expires in 60s) - ${Date.now()}`
  };

  // Get event hash and sign it with the newer method
  event.id = getEventHash(event);
  event.sig = getSignature(event, privateKey);
  
  return event;
}

// Test publishing to a single relay
async function testRelayPublishing(relayUrl) {
  const startTime = Date.now();
  const testEvent = generateTestEvent();
  
  const result = {
    relay: relayUrl,
    accepted: false,
    rejected: false,
    paywall: false,
    authRequired: false,
    error: null,
    notice: null,
    responseTime: null,
    timestamp: new Date()
  };

  return new Promise((resolve) => {
    let ws;
    let hasResponse = false;
    
    const timeout = setTimeout(() => {
      if (ws) ws.terminate();
      if (!hasResponse) {
        result.error = 'timeout';
        result.responseTime = config.timeout;
      }
      resolve(result);
    }, config.timeout);

    try {
      ws = new WebSocket(relayUrl, {
        handshakeTimeout: config.timeout,
        headers: { 'User-Agent': 'NostrBeacon/1.0 (Publishing Test)' }
      });

      ws.on('open', () => {
        // Send the test event
        const eventMsg = JSON.stringify(['EVENT', testEvent]);
        ws.send(eventMsg);
      });

      ws.on('message', (data) => {
        if (hasResponse) return;
        
        try {
          const msg = JSON.parse(data);
          const responseTime = Date.now() - startTime;
          result.responseTime = responseTime;
          hasResponse = true;
          
          if (msg[0] === 'OK') {
            // OK message format: ["OK", eventId, accepted, message]
            const [, eventId, accepted, message] = msg;
            
            if (accepted) {
              result.accepted = true;
            } else {
              result.rejected = true;
              result.notice = message || 'Event rejected';
              
              // Check for common rejection reasons
              if (message) {
                const lowerMsg = message.toLowerCase();
                if (lowerMsg.includes('payment') || lowerMsg.includes('pay') || lowerMsg.includes('invoice')) {
                  result.paywall = true;
                } else if (lowerMsg.includes('auth') || lowerMsg.includes('login') || lowerMsg.includes('credential')) {
                  result.authRequired = true;
                }
              }
            }
          } else if (msg[0] === 'NOTICE') {
            // NOTICE message format: ["NOTICE", message]
            result.notice = msg[1];
            
            const lowerNotice = msg[1].toLowerCase();
            if (lowerNotice.includes('payment') || lowerNotice.includes('pay')) {
              result.paywall = true;
            } else if (lowerNotice.includes('auth') || lowerNotice.includes('login')) {
              result.authRequired = true;
            } else {
              result.rejected = true;
            }
          }
          
          clearTimeout(timeout);
          ws.close();
          resolve(result);
          
        } catch (e) {
          // Ignore parse errors and continue waiting
        }
      });

      ws.on('error', (error) => {
        if (!hasResponse) {
          hasResponse = true;
          result.error = error.code || error.message;
          clearTimeout(timeout);
          resolve(result);
        }
      });

      ws.on('close', () => {
        if (!hasResponse) {
          hasResponse = true;
          result.error = 'connection_closed';
          clearTimeout(timeout);
          resolve(result);
        }
      });

    } catch (error) {
      result.error = error.message;
      clearTimeout(timeout);
      resolve(result);
    }
  });
}

// Main function
async function testTopRelaysPublishing() {
  const client = new MongoClient(config.mongoUrl);
  
  try {
    await client.connect();
    console.log('Connected to MongoDB');
    
    const db = client.db(config.mongoDb);
    const relaysCollection = db.collection('relays');
    
    // Get top reliable online relays
    const topRelays = await relaysCollection
      .find({ 
        online: true,
        checksTotal: { $gt: 0 },
        checksOnline: { $exists: true }
      })
      .sort({ checksOnline: -1, responseTime: 1 })
      .limit(config.topCount)
      .toArray();
    
    if (topRelays.length === 0) {
      console.log('No reliable online relays found. Run testRelayHealth.js first.');
      return;
    }
    
    console.log(`\n📤 Testing event publishing to top ${topRelays.length} reliable relays`);
    console.log(`⚙️  Configuration: timeout=${config.timeout}ms, batch=${config.batchSize}\n`);
    
    let processed = 0;
    let accepted = 0;
    let rejected = 0;
    let paywall = 0;
    let authRequired = 0;
    let errors = 0;
    const results = [];
    
    // Process in batches
    for (let i = 0; i < topRelays.length; i += config.batchSize) {
      const batch = topRelays.slice(i, i + config.batchSize);
      const batchNum = Math.floor(i / config.batchSize) + 1;
      const totalBatches = Math.ceil(topRelays.length / config.batchSize);
      
      console.log(`Batch ${batchNum}/${totalBatches}:`);
      
      const batchResults = await Promise.all(
        batch.map(r => testRelayPublishing(r.relay))
      );
      
      // Display and tally results
      for (const result of batchResults) {
        processed++;
        
        let status = '❓';
        let statusText = 'unknown';
        
        if (result.error) {
          status = '❌';
          statusText = `error: ${result.error}`;
          errors++;
        } else if (result.accepted) {
          status = '✅';
          statusText = 'accepted';
          accepted++;
        } else if (result.paywall) {
          status = '💰';
          statusText = 'paywall';
          paywall++;
        } else if (result.authRequired) {
          status = '🔐';
          statusText = 'auth required';
          authRequired++;
        } else if (result.rejected) {
          status = '❌';
          statusText = `rejected: ${result.notice || 'unknown reason'}`;
          rejected++;
        } else {
          status = '⏱️';
          statusText = 'no response';
          rejected++;
        }
        
        const time = result.responseTime ? `${result.responseTime}ms` : '';
        console.log(`  ${status} ${result.relay.padEnd(45)} ${statusText} ${time}`);
        
        // Update database with publishing test results
        await relaysCollection.updateOne(
          { relay: result.relay },
          {
            $set: {
              lastPublishTest: result.timestamp,
              acceptsEvents: result.accepted,
              requiresPayment: result.paywall,
              requiresAuth: result.authRequired,
              lastPublishError: result.error,
              lastPublishNotice: result.notice,
              publishResponseTime: result.responseTime
            },
            $inc: {
              publishTestsTotal: 1,
              ...(result.accepted ? { publishTestsAccepted: 1 } : {}),
              ...(result.paywall ? { publishTestsPaywall: 1 } : {}),
              ...(result.authRequired ? { publishTestsAuth: 1 } : {}),
              ...(result.rejected && !result.paywall && !result.authRequired ? { publishTestsRejected: 1 } : {})
            }
          }
        );
        
        results.push(result);
      }
      
      const progress = Math.round((processed / topRelays.length) * 100);
      console.log(`  → ${processed}/${topRelays.length} (${progress}%) | ✅ ${accepted} | ❌ ${rejected} | 💰 ${paywall} | 🔐 ${authRequired} | ❌ ${errors}\n`);
      
      // Pause between batches
      if (i + config.batchSize < topRelays.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    // Final summary
    console.log('='.repeat(70));
    console.log('📊 PUBLISHING TEST SUMMARY');
    console.log('='.repeat(70));
    console.log(`Tested: ${processed} relays`);
    console.log(`Accepted: ${accepted} (${Math.round((accepted/processed)*100)}%)`);
    console.log(`Rejected: ${rejected} (${Math.round((rejected/processed)*100)}%)`);
    console.log(`Paywall: ${paywall} (${Math.round((paywall/processed)*100)}%)`);
    console.log(`Auth Required: ${authRequired} (${Math.round((authRequired/processed)*100)}%)`);
    console.log(`Errors: ${errors} (${Math.round((errors/processed)*100)}%)`);
    
    // Show accepting relays by speed
    const acceptingRelays = results
      .filter(r => r.accepted)
      .sort((a, b) => (a.responseTime || 9999) - (b.responseTime || 9999));
    
    if (acceptingRelays.length > 0) {
      console.log('\n✅ Relays That Accept Events (by speed):');
      acceptingRelays.forEach((r, i) => {
        const time = r.responseTime ? `${r.responseTime}ms` : '';
        console.log(`  ${i+1}. ${r.relay} ${time}`);
      });
    }
    
    // Show paywall relays
    const paywallRelays = results.filter(r => r.paywall);
    if (paywallRelays.length > 0) {
      console.log('\n💰 Paywall Relays:');
      paywallRelays.forEach((r, i) => {
        console.log(`  ${i+1}. ${r.relay} - ${r.notice || 'Payment required'}`);
      });
    }
    
    // Show auth required relays
    const authRelays = results.filter(r => r.authRequired);
    if (authRelays.length > 0) {
      console.log('\n🔐 Auth Required Relays:');
      authRelays.forEach((r, i) => {
        console.log(`  ${i+1}. ${r.relay} - ${r.notice || 'Authentication required'}`);
      });
    }
    
    console.log('\n✅ Database updated with publishing test results');
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await client.close();
  }
}

// Export for use in other scripts
export { testRelayPublishing, testTopRelaysPublishing };

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  testTopRelaysPublishing();
}