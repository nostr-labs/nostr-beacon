import { MongoClient } from 'mongodb';

// Configuration
const config = {
  mongoUrl: process.env.MONGO_URL || 'mongodb://localhost:27017',
  mongoDb: process.env.MONGO_DB || 'nostr'
};

async function getRelays() {
  const client = new MongoClient(config.mongoUrl);
  
  try {
    await client.connect();
    console.log('Connected to MongoDB');
    
    const db = client.db(config.mongoDb);
    const relaysCollection = db.collection('relays');
    
    // Get total count
    const totalCount = await relaysCollection.countDocuments();
    console.log(`\n📡 Total unique relays: ${totalCount}\n`);
    
    // Get all relays sorted alphabetically
    const relays = await relaysCollection
      .find({})
      .sort({ relay: 1 })
      .toArray();
    
    if (relays.length === 0) {
      console.log('No relays found in the database.');
      console.log('Run followshose.js to start collecting relay data.');
      return [];
    }
    
    // Display relays in different formats
    console.log('📋 Relay List:');
    console.log('==============\n');
    
    // Group by domain for better organization
    const relaysByDomain = {};
    relays.forEach(({ relay }) => {
      try {
        const url = new URL(relay);
        const domain = url.hostname;
        if (!relaysByDomain[domain]) {
          relaysByDomain[domain] = [];
        }
        relaysByDomain[domain].push(relay);
      } catch (e) {
        // Handle invalid URLs
        if (!relaysByDomain['_invalid']) {
          relaysByDomain['_invalid'] = [];
        }
        relaysByDomain['_invalid'].push(relay);
      }
    });
    
    // Display grouped by domain
    const sortedDomains = Object.keys(relaysByDomain).sort();
    for (const domain of sortedDomains) {
      if (domain === '_invalid') continue;
      console.log(`\n${domain}:`);
      relaysByDomain[domain].forEach(relay => {
        console.log(`  ${relay}`);
      });
    }
    
    // Show invalid URLs if any
    if (relaysByDomain['_invalid']) {
      console.log('\n⚠️  Invalid URLs:');
      relaysByDomain['_invalid'].forEach(relay => {
        console.log(`  ${relay}`);
      });
    }
    
    // Statistics
    console.log('\n📊 Statistics:');
    console.log('==============');
    console.log(`Total relays: ${totalCount}`);
    console.log(`Unique domains: ${sortedDomains.filter(d => d !== '_invalid').length}`);
    
    // Protocol breakdown
    const protocols = {};
    relays.forEach(({ relay }) => {
      const protocol = relay.split('://')[0];
      protocols[protocol] = (protocols[protocol] || 0) + 1;
    });
    
    console.log('\nProtocols:');
    Object.entries(protocols).forEach(([protocol, count]) => {
      console.log(`  ${protocol}: ${count}`);
    });
    
    // Top domains by relay count
    const domainCounts = Object.entries(relaysByDomain)
      .filter(([domain]) => domain !== '_invalid')
      .map(([domain, relays]) => ({ domain, count: relays.length }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
    
    if (domainCounts.length > 0) {
      console.log('\nTop domains:');
      domainCounts.forEach(({ domain, count }) => {
        console.log(`  ${domain}: ${count} relay${count > 1 ? 's' : ''}`);
      });
    }
    
    // Export options
    console.log('\n💾 Export Formats:');
    console.log('==================\n');
    
    // JSON array format
    console.log('JSON array (for scripts):');
    console.log(JSON.stringify(relays.map(r => r.relay), null, 2).substring(0, 200) + '...\n');
    
    // Plain text format
    console.log('Plain text list (one per line):');
    relays.slice(0, 5).forEach(({ relay }) => console.log(relay));
    console.log('...\n');
    
    // CSV format
    console.log('CSV format (for spreadsheets):');
    console.log('relay_url');
    relays.slice(0, 3).forEach(({ relay }) => console.log(relay));
    console.log('...\n');
    
    // Return for programmatic use
    return relays.map(r => r.relay);
    
  } catch (error) {
    console.error('Error:', error);
    return [];
  } finally {
    await client.close();
  }
}

// Export function for use in other scripts
export { getRelays };

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  getRelays().then(relays => {
    if (process.argv.includes('--json')) {
      // Output only JSON for piping to other tools
      console.log(JSON.stringify(relays));
    } else if (process.argv.includes('--list')) {
      // Output plain list for piping
      relays.forEach(relay => console.log(relay));
    }
    // Otherwise, the formatted output is already displayed
  });
}