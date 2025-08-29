import { MongoClient } from 'mongodb';

// Configuration
const config = {
  mongoUrl: process.env.MONGO_URL || 'mongodb://localhost:27017',
  mongoDb: process.env.MONGO_DB || 'nostr',
  mongoCollection: process.env.MONGO_FOLLOWS_COLLECTION || 'follows'
};

async function getUniqueRelays() {
  const client = new MongoClient(config.mongoUrl);
  
  try {
    await client.connect();
    console.log('Connected to MongoDB');
    
    const db = client.db(config.mongoDb);
    const collection = db.collection(config.mongoCollection);
    
    // Aggregation pipeline to get all unique relays
    const pipeline = [
      // Convert relays object to array of key-value pairs
      {
        $project: {
          relayArray: { $objectToArray: "$relays" }
        }
      },
      // Unwind the array to get individual relay entries
      { $unwind: "$relayArray" },
      // Group by relay URL and collect read/write permissions
      {
        $group: {
          _id: "$relayArray.k",
          readCount: {
            $sum: { $cond: ["$relayArray.v.read", 1, 0] }
          },
          writeCount: {
            $sum: { $cond: ["$relayArray.v.write", 1, 0] }
          },
          totalUsers: { $sum: 1 }
        }
      },
      // Sort by most used relays
      { $sort: { totalUsers: -1 } },
      // Format the output
      {
        $project: {
          relay: "$_id",
          totalUsers: 1,
          readCount: 1,
          writeCount: 1,
          _id: 0
        }
      }
    ];
    
    const uniqueRelays = await collection.aggregate(pipeline).toArray();
    
    console.log(`\nFound ${uniqueRelays.length} unique relays:\n`);
    console.log('Relay URL | Total Users | Read | Write');
    console.log('----------|-------------|------|-------');
    
    uniqueRelays.forEach(relay => {
      console.log(`${relay.relay} | ${relay.totalUsers} | ${relay.readCount} | ${relay.writeCount}`);
    });
    
    // Also get just the list of unique relay URLs
    const relayUrls = uniqueRelays.map(r => r.relay);
    console.log('\n\nUnique relay URLs as array:');
    console.log(JSON.stringify(relayUrls, null, 2));
    
    return uniqueRelays;
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await client.close();
  }
}

// Run the query
getUniqueRelays();