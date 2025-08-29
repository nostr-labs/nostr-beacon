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
      .limit(300)
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
      .limit(300)
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
    
    // Get relays that accept events (from publishing tests)
    const acceptingRelays = await relaysCollection
      .find({ 
        acceptsEvents: true,
        online: true,
        publishResponseTime: { $exists: true }
      })
      .sort({ publishResponseTime: 1 })
      .limit(100)
      .toArray();
    
    if (acceptingRelays.length > 0) {
      console.log(`\n✅ Relays That Accept Events (${acceptingRelays.length}):`);
      acceptingRelays.forEach((relay, i) => {
        const time = relay.publishResponseTime ? `${relay.publishResponseTime}ms` : '';
        console.log(`  ${i+1}. ${relay.relay} - ${time}`);
      });
    }
    
    // Get relays with restrictions
    const restrictedRelays = await relaysCollection
      .find({
        $or: [
          { requiresPayment: true },
          { requiresAuth: true }
        ]
      })
      .toArray();
    
    if (restrictedRelays.length > 0) {
      const paywallRelays = restrictedRelays.filter(r => r.requiresPayment);
      const authRelays = restrictedRelays.filter(r => r.requiresAuth);
      
      if (paywallRelays.length > 0) {
        console.log(`\n💰 Paywall Relays (${paywallRelays.length}):`);
        paywallRelays.forEach((relay, i) => {
          const notice = relay.lastPublishNotice || 'Payment required';
          console.log(`  ${i+1}. ${relay.relay} - ${notice}`);
        });
      }
      
      if (authRelays.length > 0) {
        console.log(`\n🔐 Auth Required Relays (${authRelays.length}):`);
        authRelays.forEach((relay, i) => {
          const notice = relay.lastPublishNotice || 'Authentication required';
          console.log(`  ${i+1}. ${relay.relay} - ${notice}`);
        });
      }
    }
    
    // Publishing test statistics
    const publishStats = await relaysCollection.aggregate([
      {
        $match: { 
          publishTestsTotal: { $exists: true, $gt: 0 }
        }
      },
      {
        $group: {
          _id: null,
          totalTested: { $sum: 1 },
          accepting: { $sum: { $cond: ["$acceptsEvents", 1, 0] } },
          paywall: { $sum: { $cond: ["$requiresPayment", 1, 0] } },
          authRequired: { $sum: { $cond: ["$requiresAuth", 1, 0] } }
        }
      }
    ]).toArray();
    
    if (publishStats.length > 0) {
      const stats = publishStats[0];
      console.log('\n📤 Publishing Test Summary:');
      console.log(`  Tested: ${stats.totalTested} relays`);
      console.log(`  Accepting: ${stats.accepting} (${Math.round((stats.accepting/stats.totalTested)*100)}%)`);
      console.log(`  Paywall: ${stats.paywall} (${Math.round((stats.paywall/stats.totalTested)*100)}%)`);
      console.log(`  Auth Required: ${stats.authRequired} (${Math.round((stats.authRequired/stats.totalTested)*100)}%)`);
      const rejected = stats.totalTested - stats.accepting - stats.paywall - stats.authRequired;
      console.log(`  Rejected/Restricted: ${rejected} (${Math.round((rejected/stats.totalTested)*100)}%)`);
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