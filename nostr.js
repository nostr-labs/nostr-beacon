import { SimplePool, validateEvent } from 'nostr-tools'
import { upsertProfile } from './db.js'
import dotenv from 'dotenv'
dotenv.config()

const pool = new SimplePool()
const relays = process.env.RELAYS.split(',')

export async function fetchProfiles(pubkeys) {
  const sub = pool.sub(relays, [
    {
      kinds: [0],
      authors: pubkeys
    }
  ])

  sub.on('event', async (event) => {
    if (validateEvent(event)) {
      await upsertProfile(event)
    }
  })

  setTimeout(() => {
    sub.unsub()
  }, 5000)
}

