import express from 'express';
import fs from 'fs';
import path from 'path';
import { MongoClient } from 'mongodb';
import { fileURLToPath } from 'url';

// Configuration
const config = {
  port: process.env.PORT || 3000,
  storage: process.env.STORAGE_TYPE || 'file', // 'file' or 'mongodb'
  mongoUrl: process.env.MONGO_URL || 'mongodb://localhost:27017',
  mongoDb: process.env.MONGO_DB || 'nostr',
  mongoCollection: process.env.MONGO_COLLECTION || 'beacon'
};

// Image URL verification helper function
function isValidImageUrl (url) {
  if (!url) return false;
  // Check if it's a relative path to our server
  if (url.startsWith('/')) return true;
  // Check if it's an HTTPS URL with image extension or standard image domains
  return (
    url.startsWith('https://') &&
    (
      url.match(/\.(jpg|jpeg|png|gif|svg|webp)($|\?)/) ||
      url.includes('imgur.com') ||
      url.includes('cloudfront.net') ||
      url.includes('nostr.build')
    )
  );
}

// Generate a consistent color based on the string
function stringToColor (str) {
  if (!str) return '#E0E0E0';

  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }

  // Generate a vibrant but not too bright color
  const hue = hash % 360;
  return `hsl(${hue}, 60%, 70%)`;
}

// Generate DID document for Nostr profile
function generateDidDocument (pubkey) {
  if (!pubkey) return null;

  return {
    "@context": [
      "https://www.w3.org/ns/did/v1",
      "https://w3id.org/nostr/context"
    ],
    "id": `did:nostr:${pubkey}`,
    "verificationMethod": [
      {
        "id": `did:nostr:${pubkey}#key1`,
        "controller": `did:nostr:${pubkey}`,
        "type": "SchnorrVerification2025"
      }
    ],
    "authentication": [
      "#key1"
    ],
    "assertionMethod": [
      "#key1"
    ]
  };
}

// MongoDB setup
let mongoClient;
let beaconCollection;

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function connectToMongo () {
  if (config.storage === 'mongodb') {
    try {
      mongoClient = new MongoClient(config.mongoUrl);
      await mongoClient.connect();
      console.log('Connected to MongoDB');

      const db = mongoClient.db(config.mongoDb);
      beaconCollection = db.collection(config.mongoCollection);

      // Create index on pubkey for faster lookups
      await beaconCollection.createIndex({ pubkey: 1 }, { unique: true });

      // Add index for created_at for sorting by most recent
      await beaconCollection.createIndex({ created_at: -1 });

      // Add index for updated_at for sorting by most recently updated profiles
      await beaconCollection.createIndex({ updated_at: -1 });
    } catch (error) {
      console.error('MongoDB connection error:', error);
      process.exit(1);
    }
  }
}

// Save profile function
async function saveProfile (event) {
  const pubkey = event.pubkey;

  // Add timestamp for sorting by recency
  event.updated_at = new Date();

  if (config.storage === 'file') {
    // Ensure data directory exists
    const dataDir = path.join(__dirname, 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // Save profile to file
    const filePath = path.join(dataDir, `${pubkey}.json`);
    fs.writeFileSync(filePath, JSON.stringify(event, null, 2));
    console.log(`Saved profile for ${pubkey} to file`);
  }
  else if (config.storage === 'mongodb') {
    try {
      // Update or insert the profile
      await beaconCollection.updateOne(
        { pubkey: pubkey },
        { $set: event },
        { upsert: true }
      );
      console.log(`Saved profile for ${pubkey} to MongoDB`);
    } catch (error) {
      console.error(`Error saving profile to MongoDB:`, error);
    }
  }
}

// Get recent profiles
async function getRecentProfiles (limit = 50) {
  if (config.storage === 'file') {
    const dataDir = path.join(__dirname, 'data');
    if (!fs.existsSync(dataDir)) {
      return [];
    }

    try {
      const files = fs.readdirSync(dataDir);
      const profiles = [];

      for (const file of files) {
        if (file.endsWith('.json')) {
          const filePath = path.join(dataDir, file);
          const stats = fs.statSync(filePath);
          const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

          profiles.push({
            ...data,
            updated_at: stats.mtime
          });
        }
      }

      // Sort by last modified time (most recent first)
      return profiles
        .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))
        .slice(0, limit);
    } catch (error) {
      console.error('Error reading profiles from files:', error);
      return [];
    }
  }
  else if (config.storage === 'mongodb') {
    try {
      return await beaconCollection
        .find({})
        .sort({ updated_at: -1 })
        .limit(limit)
        .toArray();
    } catch (error) {
      console.error('Error fetching profiles from MongoDB:', error);
      return [];
    }
  }

  return [];
}

// Get a specific profile
async function getProfile (pubkey) {
  if (config.storage === 'file') {
    const filePath = path.join(__dirname, 'data', `${pubkey}.json`);
    if (fs.existsSync(filePath)) {
      try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch (error) {
        console.error(`Error reading profile for ${pubkey}:`, error);
        return null;
      }
    }
    return null;
  }
  else if (config.storage === 'mongodb') {
    try {
      return await beaconCollection.findOne({ pubkey });
    } catch (error) {
      console.error(`Error fetching profile for ${pubkey} from MongoDB:`, error);
      return null;
    }
  }

  return null;
}

// Initialize and start web server
(async function init () {
  await connectToMongo();

  const app = express();

  // Serve static files
  app.use(express.static(path.join(__dirname, 'public')));

  // Home page - list of recent profiles
  app.get('/', async (req, res) => {
    const profiles = await getRecentProfiles();
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Nostr Profile Beacon</title>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            body {
              font-family: system-ui, -apple-system, sans-serif;
              line-height: 1.5;
              max-width: 800px;
              margin: 0 auto;
              padding: 20px;
              color: #333;
            }
            h1 {
              text-align: center;
              margin-bottom: 30px;
            }
            .profile-list {
              list-style: none;
              padding: 0;
            }
            .profile-item {
              border: 1px solid #ddd;
              border-radius: 5px;
              margin-bottom: 10px;
              padding: 15px;
              transition: all 0.2s;
            }
            .profile-item:hover {
              box-shadow: 0 2px 8px rgba(0,0,0,0.1);
            }
            .profile-link {
              display: flex;
              align-items: center;
              text-decoration: none;
              color: inherit;
            }
            .profile-picture {
              width: 50px;
              height: 50px;
              border-radius: 50%;
              margin-right: 15px;
              object-fit: cover;
              background-color: #E0E0E0; /* Placeholder background */
              display: flex;
              justify-content: center;
              align-items: center;
              overflow: hidden;
            }
            .profile-picture-initial {
              font-size: 24px;
              font-weight: bold;
              color: #888;
              text-transform: uppercase;
            }
            .profile-name {
              font-weight: bold;
              font-size: 1.1em;
              margin: 0;
            }
            .profile-pubkey {
              font-family: monospace;
              color: #666;
              font-size: 0.9em;
              margin: 0;
            }
            .did-indicator {
              display: inline-block;
              background-color: #e6f2ff;
              color: #0066cc;
              font-size: 0.8em;
              padding: 2px 6px;
              border-radius: 3px;
              margin-left: 5px;
              vertical-align: middle;
            }
            .updated-at {
              color: #666;
              font-size: 0.8em;
              margin-top: 5px;
            }
          </style>
        </head>
        <body>
          <h1>Recent Nostr Profiles</h1>
          <ul class="profile-list">
            ${profiles.map(profile => {
      const content = profile.content ? JSON.parse(profile.content) : {};
      const name = content.name || content.display_name || 'Anonymous';

      // Validate picture URL for safety
      let picture = '/default-avatar.svg';
      if (content.picture && isValidImageUrl(content.picture)) {
        picture = content.picture;
      }

      const initial = name.charAt(0);
      const bgColor = stringToColor(profile.pubkey);

      // Fix for Invalid Date issue
      let updatedText = 'Recently updated';
      try {
        if (profile.updated_at) {
          const updatedDate = new Date(profile.updated_at);
          if (!isNaN(updatedDate.getTime())) {
            updatedText = `Updated: ${updatedDate.toLocaleString()}`;
          }
        } else if (profile.created_at) {
          const createdDate = new Date(profile.created_at * 1000); // Convert Unix timestamp if needed
          if (!isNaN(createdDate.getTime())) {
            updatedText = `Created: ${createdDate.toLocaleString()}`;
          }
        }
      } catch (e) {
        console.error('Date parsing error:', e);
      }

      return `
                <li class="profile-item">
                  <a href="/profile/${profile.pubkey}" class="profile-link">
                    <div class="profile-picture" style="background-color: ${bgColor};">
                      <img src="${picture}" style="width: 100%; height: 100%;" 
                          onerror="this.style.display='none'; this.parentNode.innerHTML = '<div class=\'profile-picture-initial\'>${initial}</div>';"
                          loading="lazy">
                    </div>
                    <div>
                      <p class="profile-name">${name}</p>
                      <p class="profile-pubkey">${profile.pubkey.substring(0, 10)}...
                        <span class="did-indicator" title="Decentralized Identifier">DID</span>
                      </p>
                      <p class="updated-at">${updatedText}</p>
                    </div>
                  </a>
                </li>
              `;
    }).join('')}
          </ul>
        </body>
      </html>
    `);
  });

  // Profile detail page
  app.get('/profile/:pubkey', async (req, res) => {
    const profile = await getProfile(req.params.pubkey);

    if (!profile) {
      return res.status(404).send('Profile not found');
    }

    const content = profile.content ? JSON.parse(profile.content) : {};
    const name = content.name || content.display_name || 'Anonymous';

    // Validate picture URL for safety
    let picture = '/default-avatar.svg';
    if (content.picture && isValidImageUrl(content.picture)) {
      picture = content.picture;
    }

    const initial = name.charAt(0);
    const bgColor = stringToColor(profile.pubkey);
    const about = content.about || 'No description provided';
    const website = content.website || '';
    const nip05 = content.nip05 || '';

    // Fix for date display
    let createdText = 'Unknown date';
    try {
      if (profile.created_at) {
        const createdDate = new Date(profile.created_at * 1000); // Convert Unix timestamp
        if (!isNaN(createdDate.getTime())) {
          createdText = createdDate.toLocaleString();
        }
      }
    } catch (e) {
      console.error('Date parsing error:', e);
    }

    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>${name} - Nostr Profile</title>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            body {
              font-family: system-ui, -apple-system, sans-serif;
              line-height: 1.5;
              max-width: 800px;
              margin: 0 auto;
              padding: 20px;
              color: #333;
            }
            .back-link {
              display: inline-block;
              margin-bottom: 20px;
              text-decoration: none;
              color: #0066cc;
            }
            .profile-header {
              display: flex;
              align-items: center;
              margin-bottom: 30px;
            }
            .profile-picture {
              width: 100px;
              height: 100px;
              border-radius: 50%;
              margin-right: 20px;
              object-fit: cover;
              background-color: #E0E0E0; /* Placeholder background */
              display: flex;
              justify-content: center;
              align-items: center;
              overflow: hidden;
            }
            .profile-picture-initial {
              font-size: 36px;
              font-weight: bold;
              color: #888;
              text-transform: uppercase;
            }
            .profile-name {
              font-size: 2em;
              margin: 0;
            }
            .profile-pubkey {
              font-family: monospace;
              word-break: break-all;
              color: #666;
              margin: 5px 0;
            }
            .profile-section {
              margin-bottom: 30px;
            }
            .profile-section h2 {
              border-bottom: 1px solid #ddd;
              padding-bottom: 5px;
            }
            .metadata dt {
              font-weight: bold;
              margin-top: 10px;
            }
            .metadata dd {
              margin-left: 0;
            }
            pre {
              background: #f5f5f5;
              padding: 15px;
              overflow: auto;
              border-radius: 5px;
            }
            .did-section {
              background-color: #f8f9fa;
              border: 1px solid #e9ecef;
              border-radius: 5px;
              padding: 15px;
              margin-top: 10px;
            }
            .api-link {
              display: inline-block;
              margin-top: 10px;
              color: #0066cc;
              text-decoration: none;
              font-size: 0.9em;
            }
            .api-link:hover {
              text-decoration: underline;
            }
          </style>
        </head>
        <body>
          <a href="/" class="back-link">← Back to list</a>
          
          <div class="profile-header">
            <div class="profile-picture" style="background-color: ${bgColor};">
              <img src="${picture}" style="width: 100%; height: 100%;" 
                  onerror="this.style.display='none'; this.parentNode.innerHTML = '<div class=\'profile-picture-initial\'>${initial}</div>';"
                  loading="lazy">
            </div>
            <div>
              <h1 class="profile-name">${name}</h1>
              <p class="profile-pubkey">${profile.pubkey}</p>
            </div>
          </div>
          
          <div class="profile-section">
            <h2>About</h2>
            <p>${about}</p>
          </div>
          
          <div class="profile-section">
            <h2>Metadata</h2>
            <dl class="metadata">
              ${website ? `<dt>Website</dt><dd><a href="${website}" target="_blank">${website}</a></dd>` : ''}
              ${nip05 ? `<dt>NIP-05</dt><dd>${nip05}</dd>` : ''}
              <dt>Created</dt><dd>${createdText}</dd>
              <dt>Nostr DID</dt><dd>did:nostr:${profile.pubkey}</dd>
            </dl>
          </div>
          
          <div class="profile-section">
            <h2>DID Document</h2>
            <div class="did-section">
              <pre>${JSON.stringify(generateDidDocument(profile.pubkey), null, 2)}</pre>
              <a href="/api/did/${profile.pubkey}" target="_blank" class="api-link">View as JSON API endpoint</a>
              <a href="/.well-known/did/nostr/${profile.pubkey}.json" target="_blank" class="api-link">View as standardized DID document</a>
            </div>
          </div>
          
          <div class="profile-section">
            <h2>Raw JSON</h2>
            <pre>${JSON.stringify(profile, null, 2)}</pre>
          </div>
        </body>
      </html>
    `);
  });

  // API endpoint for recent profiles (JSON)
  app.get('/api/profiles', async (req, res) => {
    const limit = parseInt(req.query.limit) || 10;
    const profiles = await getRecentProfiles(limit);
    res.json(profiles);
  });

  // API endpoint for specific profile (JSON)
  app.get('/api/profile/:pubkey', async (req, res) => {
    const profile = await getProfile(req.params.pubkey);
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }
    res.json(profile);
  });

  // DID Document API endpoint
  app.get('/api/did/:pubkey', async (req, res) => {
    const pubkey = req.params.pubkey;
    const didDocument = generateDidDocument(pubkey);

    if (!didDocument) {
      return res.status(404).json({ error: 'Could not generate DID document' });
    }

    res.json(didDocument);
  });

  // Standard DID Document endpoint according to DID specification
  app.get('/.well-known/did/nostr/:pubkey.json', async (req, res) => {
    const pubkey = req.params.pubkey;
    const didDocument = generateDidDocument(pubkey);

    if (!didDocument) {
      return res.status(404).json({ error: 'Could not generate DID document' });
    }

    // Set appropriate content type and cache headers
    res.setHeader('Content-Type', 'application/did+json');
    res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 1 day

    res.json(didDocument);
  });

  // Well-known DID configuration
  app.get('/.well-known/did-configuration.json', async (req, res) => {
    // Get the most recent profiles for the well-known configuration
    const profiles = await getRecentProfiles(10);

    // Create a DID configuration with verificationMethod for each profile
    const didConfiguration = {
      "@context": "https://identity.foundation/.well-known/did-configuration/v1",
      "linked_dids": []
    };

    // Add each profile's DID as a linked_did
    for (const profile of profiles) {
      if (profile.pubkey) {
        const didDoc = generateDidDocument(profile.pubkey);
        if (didDoc) {
          didConfiguration.linked_dids.push(didDoc);
        }
      }
    }

    res.json(didConfiguration);
  });

  // Create public directory for static files if it doesn't exist
  const publicDir = path.join(__dirname, 'public');
  if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir, { recursive: true });
  }

  // Create a default avatar
  const defaultAvatarPath = path.join(publicDir, 'default-avatar.png');
  const svgPath = path.join(publicDir, 'default-avatar.svg');

  // Always create SVG default avatar regardless of PNG existence
  try {
    const svgContent = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="200" height="200" xmlns="http://www.w3.org/2000/svg">
  <!-- Background Circle -->
  <circle cx="100" cy="100" r="100" fill="#E0E0E0"/>
  
  <!-- User Silhouette -->
  <circle cx="100" cy="75" r="35" fill="#AAAAAA"/>
  <path d="M160,175 C160,130 130,110 100,110 C70,110 40,130 40,175 Z" fill="#AAAAAA"/>
</svg>`;
    fs.writeFileSync(svgPath, svgContent);
    console.log('Created/updated default avatar SVG at:', svgPath);
  } catch (error) {
    console.error('Error creating default avatar SVG:', error);
  }

  // Start server
  app.listen(config.port, () => {
    console.log(`Nostr Profile Beacon server running at http://localhost:${config.port}`);
  });

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    console.log('Shutting down...');
    if (mongoClient) await mongoClient.close();
    process.exit(0);
  });
})();

