import { MongoClient } from 'mongodb';

// Configuration
const config = {
  mongoUrl: process.env.MONGO_URL || 'mongodb://localhost:27017',
  mongoDb: process.env.MONGO_DB || 'nostr',
  mongoCollection: process.env.MONGO_FOLLOWS_COLLECTION || 'follows'
};

async function countUniqueUsers() {
  const client = new MongoClient(config.mongoUrl);
  
  try {
    await client.connect();
    console.log('Connected to MongoDB');
    
    const db = client.db(config.mongoDb);
    const collection = db.collection(config.mongoCollection);
    
    // Get total count of documents (unique users with follow lists)
    const totalUsers = await collection.countDocuments();
    console.log(`\n📊 Total unique users with follow lists: ${totalUsers.toLocaleString()}`);
    
    // Get all unique pubkeys (users with lists + all followed users)
    console.log(`\n🔍 Calculating total unique users (this may take a moment)...`);
    
    const allUniqueUsersPipeline = [
      // First get all pubkeys that have follow lists
      {
        $group: {
          _id: null,
          usersWithLists: { $addToSet: "$pubkey" },
          allFollows: { $push: "$follows" }
        }
      },
      // Unwind the follows array
      {
        $project: {
          usersWithLists: 1,
          allFollows: {
            $reduce: {
              input: "$allFollows",
              initialValue: [],
              in: { $concatArrays: ["$$value", "$$this"] }
            }
          }
        }
      },
      // Extract followed pubkeys
      {
        $project: {
          usersWithLists: 1,
          followedUsers: {
            $map: {
              input: "$allFollows",
              as: "follow",
              in: "$$follow.pubkey"
            }
          }
        }
      },
      // Combine all unique pubkeys
      {
        $project: {
          allUniquePubkeys: {
            $setUnion: ["$usersWithLists", "$followedUsers"]
          },
          usersWithListsCount: { $size: "$usersWithLists" },
          followedUsersSet: { $setUnion: ["$followedUsers", []] }
        }
      },
      {
        $project: {
          totalUniqueUsers: { $size: "$allUniquePubkeys" },
          usersWithLists: "$usersWithListsCount",
          uniqueFollowedUsers: { $size: "$followedUsersSet" },
          usersOnlyFollowed: {
            $size: {
              $setDifference: ["$followedUsersSet", "$allUniquePubkeys"]
            }
          }
        }
      }
    ];
    
    const uniqueUsersResult = await collection.aggregate(allUniqueUsersPipeline, {
      allowDiskUse: true
    }).toArray();
    
    if (uniqueUsersResult.length > 0) {
      const u = uniqueUsersResult[0];
      console.log(`\n👥 Total Unique Users Breakdown:`);
      console.log(`   Total unique users (all): ${u.totalUniqueUsers.toLocaleString()}`);
      console.log(`   Users with follow lists: ${totalUsers.toLocaleString()}`);
      console.log(`   Unique followed users: ${u.uniqueFollowedUsers.toLocaleString()}`);
      const onlyFollowed = u.totalUniqueUsers - totalUsers;
      console.log(`   Users only being followed (no list): ${onlyFollowed.toLocaleString()}`);
    }
    
    // Get statistics about the follow lists
    const statsePipeline = [
      {
        $group: {
          _id: null,
          totalUsers: { $sum: 1 },
          avgFollowsCount: { $avg: "$followsCount" },
          maxFollowsCount: { $max: "$followsCount" },
          minFollowsCount: { $min: "$followsCount" },
          totalFollows: { $sum: "$followsCount" },
          usersWithRelays: {
            $sum: {
              $cond: [{ $gt: [{ $size: { $objectToArray: "$relays" } }, 0] }, 1, 0]
            }
          }
        }
      }
    ];
    
    const stats = await collection.aggregate(statsePipeline).toArray();
    
    if (stats.length > 0) {
      const s = stats[0];
      console.log(`\n📈 Statistics:`);
      console.log(`   Average follows per user: ${Math.round(s.avgFollowsCount)}`);
      console.log(`   Maximum follows: ${s.maxFollowsCount}`);
      console.log(`   Minimum follows: ${s.minFollowsCount}`);
      console.log(`   Total follow relationships: ${s.totalFollows.toLocaleString()}`);
      console.log(`   Users with relay preferences: ${s.usersWithRelays.toLocaleString()}`);
    }
    
    // Get distribution of follow counts (bucketed)
    const distributionPipeline = [
      {
        $bucket: {
          groupBy: "$followsCount",
          boundaries: [0, 10, 50, 100, 500, 1000, 5000, 10000],
          default: "10000+",
          output: {
            count: { $sum: 1 },
            avgFollows: { $avg: "$followsCount" }
          }
        }
      },
      { $sort: { "_id": 1 } }
    ];
    
    const distribution = await collection.aggregate(distributionPipeline).toArray();
    
    console.log(`\n📊 Follow count distribution:`);
    distribution.forEach(bucket => {
      const label = bucket._id === "10000+" ? "10000+" : `${bucket._id}-${bucket._id === 5000 ? '10000' : (typeof bucket._id === 'number' ? (bucket._id < 5000 ? [10, 50, 100, 500, 1000, 5000][Math.max(0, [0, 10, 50, 100, 500, 1000, 5000].indexOf(bucket._id))] : bucket._id) : bucket._id)}`;
      console.log(`   ${label.padEnd(12)} users: ${bucket.count.toLocaleString().padStart(8)} (avg: ${Math.round(bucket.avgFollows)})`);
    });
    
    // Get top 10 most followed pubkeys
    console.log(`\n🏆 Calculating most followed pubkeys (this may take a moment)...`);
    
    const mostFollowedPipeline = [
      { $unwind: "$follows" },
      {
        $group: {
          _id: "$follows.pubkey",
          followerCount: { $sum: 1 }
        }
      },
      { $sort: { followerCount: -1 } },
      { $limit: 10 }
    ];
    
    const mostFollowed = await collection.aggregate(mostFollowedPipeline, {
      allowDiskUse: true // Allow disk use for large datasets
    }).toArray();
    
    console.log(`\n🏆 Top 10 most followed pubkeys:`);
    mostFollowed.forEach((user, index) => {
      console.log(`   ${(index + 1).toString().padStart(2)}. ${user._id} - ${user.followerCount.toLocaleString()} followers`);
    });
    
    // Get sample of recent additions
    const recentPipeline = [
      { $sort: { updatedAt: -1 } },
      { $limit: 5 },
      {
        $project: {
          pubkey: 1,
          followsCount: 1,
          updatedAt: 1,
          relayCount: { $size: { $objectToArray: "$relays" } }
        }
      }
    ];
    
    const recent = await collection.aggregate(recentPipeline).toArray();
    
    console.log(`\n🕐 5 Most recently updated users:`);
    recent.forEach(user => {
      const dateStr = user.updatedAt ? new Date(user.updatedAt).toISOString() : 'N/A';
      console.log(`   ${user.pubkey.substring(0, 8)}... - ${user.followsCount} follows, ${user.relayCount} relays (${dateStr})`);
    });
    
    // Database size estimate
    const dbStats = await db.stats();
    const collectionStats = await collection.stats();
    
    console.log(`\n💾 Storage Information:`);
    console.log(`   Database size: ${(dbStats.dataSize / (1024 * 1024)).toFixed(2)} MB`);
    console.log(`   Collection size: ${(collectionStats.size / (1024 * 1024)).toFixed(2)} MB`);
    console.log(`   Average document size: ${(collectionStats.avgObjSize / 1024).toFixed(2)} KB`);
    console.log(`   Index size: ${(collectionStats.totalIndexSize / (1024 * 1024)).toFixed(2)} MB`);
    
    return {
      totalUsers,
      stats: stats[0],
      distribution,
      mostFollowed,
      recent
    };
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await client.close();
  }
}

// Run the analysis
countUniqueUsers();