import { MongoClient } from 'mongodb';

const config = {
  mongoUrl: process.env.MONGO_URL || 'mongodb://localhost:27017',
  mongoDb: process.env.MONGO_DB || 'nostr'
};

async function viewRelayHealth() {
  const client = new MongoClient(config.mongoUrl);
  
  try {
    await client.connect();
    console.log('Connected to MongoDB');
    
    const db = client.db(config.mongoDb);
    const relaysCollection = db.collection('relays');
    
    // Get overall statistics
    const totalRelays = await relaysCollection.countDocuments();
    const onlineRelays = await relaysCollection.countDocuments({ online: true });
    const offlineRelays = totalRelays - onlineRelays;
    
    console.log(`\n📊 Relay Health Summary`);
    console.log('='.repeat(50));
    console.log(`Total relays: ${totalRelays}`);
    console.log(`Online: ${onlineRelays} (${Math.round((onlineRelays/totalRelays)*100)}%)`);
    console.log(`Offline: ${offlineRelays} (${Math.round((offlineRelays/totalRelays)*100)}%)`);
    
    // Get fastest online relays
    const fastestRelays = await relaysCollection
      .find({ online: true, responseTime: { $exists: true, $ne: null } })
      .sort({ responseTime: 1 })
      .limit(100)
      .toArray();
    
    if (fastestRelays.length > 0) {
      console.log(`\n⚡ Top ${fastestRelays.length} Fastest Relays:`);
      fastestRelays.forEach((relay, i) => {
        console.log(`  ${i+1}. ${relay.relay} - ${relay.responseTime}ms`);
      });
    }
    
    // Get most reliable relays (by uptime)
    const reliableRelays = await relaysCollection
      .find({ 
        checksTotal: { $gt: 0 },
        checksOnline: { $exists: true }
      })
      .sort({ checksOnline: -1 })
      .limit(100)
      .toArray();
    
    if (reliableRelays.length > 0 && reliableRelays[0].checksTotal > 1) {
      console.log(`\n🏆 Top ${reliableRelays.length} Most Reliable Relays:`);
      reliableRelays.forEach((relay, i) => {
        const uptime = Math.round((relay.checksOnline / relay.checksTotal) * 100);
        console.log(`  ${i+1}. ${relay.relay} - ${uptime}% (${relay.checksOnline}/${relay.checksTotal})`);
      });
    }
    
    // Get error breakdown
    const errorPipeline = [
      { $match: { online: false, lastError: { $exists: true, $ne: null } } },
      { $group: { _id: "$lastError", count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ];
    
    const errors = await relaysCollection.aggregate(errorPipeline).toArray();
    
    if (errors.length > 0) {
      console.log('\n🚨 Error Breakdown:');
      errors.forEach(error => {
        console.log(`  ${error._id}: ${error.count} relays`);
      });
    }
    
    // Recent checks
    const recentChecks = await relaysCollection
      .find({ lastChecked: { $exists: true } })
      .sort({ lastChecked: -1 })
      .limit(5)
      .toArray();
    
    if (recentChecks.length > 0) {
      console.log('\n🕐 Recently Checked:');
      recentChecks.forEach(relay => {
        const status = relay.online ? '✅' : '❌';
        const time = relay.responseTime ? `${relay.responseTime}ms` : '';
        const checked = new Date(relay.lastChecked).toLocaleString();
        console.log(`  ${status} ${relay.relay.substring(0, 40).padEnd(40)} ${time} (${checked})`);
      });
    }
    
    return {
      total: totalRelays,
      online: onlineRelays,
      offline: offlineRelays,
      fastest: fastestRelays,
      errors
    };
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await client.close();
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  viewRelayHealth();
}

export { viewRelayHealth }; 