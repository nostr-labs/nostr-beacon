import WebSocket from 'ws';
import { MongoClient } from 'mongodb';

// Configuration
const config = {
  mongoUrl: process.env.MONGO_URL || 'mongodb://localhost:27017',
  mongoDb: process.env.MONGO_DB || 'nostr',
  timeout: parseInt(process.env.TIMEOUT) || 5000, // 5 second timeout per relay
  batchSize: parseInt(process.env.BATCH_SIZE) || 5, // Test 5 relays at a time (gentle)
  pauseBetweenBatches: 2000 // 2 second pause between batches
};

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

// Test a single relay
async function testRelay(relayUrl) {
  const startTime = Date.now();
  
  return new Promise((resolve) => {
    let ws;
    let connected = false;
    
    const timeout = setTimeout(() => {
      if (ws) ws.terminate();
      resolve({
        relay: relayUrl,
        online: false,
        responseTime: null,
        error: 'timeout',
        timestamp: new Date()
      });
    }, config.timeout);

    try {
      ws = new WebSocket(relayUrl, {
        handshakeTimeout: config.timeout,
        headers: { 'User-Agent': 'NostrBeacon/1.0' }
      });

      ws.on('open', () => {
        connected = true;
        const responseTime = Date.now() - startTime;
        
        clearTimeout(timeout);
        ws.close();
        
        resolve({
          relay: relayUrl,
          online: true,
          responseTime,
          error: null,
          timestamp: new Date()
        });
      });

      ws.on('error', (error) => {
        clearTimeout(timeout);
        resolve({
          relay: relayUrl,
          online: false,
          responseTime: null,
          error: error.code || error.message,
          timestamp: new Date()
        });
      });

    } catch (error) {
      clearTimeout(timeout);
      resolve({
        relay: relayUrl,
        online: false,
        responseTime: null,
        error: error.message,
        timestamp: new Date()
      });
    }
  });
}

async function checkAllRelayHealth() {
  const client = new MongoClient(config.mongoUrl);
  
  try {
    await client.connect();
    console.log('Connected to MongoDB');
    
    const db = client.db(config.mongoDb);
    const relaysCollection = db.collection('relays');
    
    // Get all relays
    const relays = await relaysCollection.find({}).sort({ relay: 1 }).toArray();
    
    if (relays.length === 0) {
      console.log('No relays found. Run followshose.js first to collect relays.');
      return;
    }
    
    console.log(`\n🏥 Testing ${relays.length} relays (${config.batchSize} at a time, ${config.timeout}ms timeout)`);
    console.log('Being gentle: pausing between batches...\n');
    
    let processed = 0;
    let online = 0;
    let offline = 0;
    const startTime = Date.now();
    const results = [];
    
    // Process in small batches to be gentle
    for (let i = 0; i < relays.length; i += config.batchSize) {
      const batch = relays.slice(i, i + config.batchSize);
      const batchNum = Math.floor(i / config.batchSize) + 1;
      const totalBatches = Math.ceil(relays.length / config.batchSize);
      
      console.log(`Batch ${batchNum}/${totalBatches}:`);
      
      const batchResults = await Promise.all(
        batch.map(r => testRelay(r.relay))
      );
      
      // Display and save results
      for (const result of batchResults) {
        processed++;
        
        const status = result.online ? '✅' : '❌';
        const time = result.responseTime ? `${result.responseTime}ms` : '';
        const error = result.error ? `(${result.error})` : '';
        
        console.log(`  ${status} ${result.relay.padEnd(45)} ${time} ${error}`);
        
        if (result.online) online++;
        else offline++;
        
        // Canonicalize URL before storing
        const canonicalUrl = canonicalizeRelayUrl(result.relay);
        
        // Update database using canonical URL
        await relaysCollection.updateOne(
          { relay: canonicalUrl },
          {
            $set: {
              relay: canonicalUrl, // Ensure it's stored canonically
              online: result.online,
              lastChecked: result.timestamp,
              responseTime: result.responseTime,
              lastError: result.error,
              uptime: result.online ? (((result.checksOnline || 0) + 1) / ((result.checksTotal || 0) + 1) * 100) : null
            },
            $inc: {
              checksTotal: 1,
              ...(result.online ? { checksOnline: 1 } : {})
            }
          },
          { upsert: true }
        );
        
        results.push(result);
      }
      
      const progress = Math.round((processed / relays.length) * 100);
      console.log(`  → ${processed}/${relays.length} (${progress}%) | ✅ ${online} | ❌ ${offline}\n`);
      
      // Gentle pause between batches
      if (i + config.batchSize < relays.length) {
        await new Promise(resolve => setTimeout(resolve, config.pauseBetweenBatches));
      }
    }
    
    const duration = Math.round((Date.now() - startTime) / 1000);
    
    console.log('='.repeat(60));
    console.log('📊 HEALTH CHECK COMPLETE');
    console.log('='.repeat(60));
    console.log(`Duration: ${duration}s`);
    console.log(`Online: ${online}/${relays.length} (${Math.round((online/relays.length)*100)}%)`);
    console.log(`Offline: ${offline}/${relays.length} (${Math.round((offline/relays.length)*100)}%)`);
    
    // Show fastest relays
    const fastest = results
      .filter(r => r.online && r.responseTime)
      .sort((a, b) => a.responseTime - b.responseTime)
      .slice(0, 5);
    
    if (fastest.length > 0) {
      console.log('\n⚡ Fastest Relays:');
      fastest.forEach((r, i) => {
        console.log(`  ${i+1}. ${r.relay} - ${r.responseTime}ms`);
      });
    }
    
    // Show common errors
    const errorCounts = {};
    results.filter(r => !r.online && r.error).forEach(r => {
      errorCounts[r.error] = (errorCounts[r.error] || 0) + 1;
    });
    
    if (Object.keys(errorCounts).length > 0) {
      console.log('\n🚨 Common Errors:');
      Object.entries(errorCounts)
        .sort((a, b) => b[1] - a[1])
        .forEach(([error, count]) => {
          console.log(`  ${error}: ${count} relays`);
        });
    }
    
    console.log('\n✅ Database updated with health statistics');
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await client.close();
  }
}

// Export for use in other scripts
export { testRelay, checkAllRelayHealth };

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  checkAllRelayHealth();
}