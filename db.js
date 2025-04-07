import { MongoClient } from 'mongodb'
import dotenv from 'dotenv'
dotenv.config()

const client = new MongoClient(process.env.MONGODB_URI)
await client.connect()
const db = client.db(process.env.DB_NAME)
const profiles = db.collection('profiles')

export async function upsertProfile(event) {
  const { pubkey, created_at } = event
  const existing = await profiles.findOne({ pubkey })

  console.log('inserting ', pubkey)

  if (!existing || existing.created_at < created_at) {
    await profiles.updateOne(
      { pubkey },
      { $set: { ...event } },
      { upsert: true }
    )
  }
}

export async function getProfile(pubkey) {
  return await profiles.findOne({ pubkey })
}

