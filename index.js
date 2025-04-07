import express from 'express'
import { getProfile } from './db.js'
import { fetchProfiles } from './nostr.js'

const app = express()

app.get('/.well-known/did/nostr/:pubkey.json', async (req, res) => {
  const { pubkey } = req.params
  const profile = await getProfile(pubkey)

  if (!profile) {
    // Optionally trigger fetch if not found
    await fetchProfiles([pubkey])
    return res.status(404).json({ error: 'Profile not found' })
  }

  res.json(profile)
})

app.listen(3100, () => {
  console.log('Server running on http://localhost:3000')
})

