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
      url.includes('nostr.build') ||
      url.includes('dicebear.com')
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
function generateDidDocument (pubkey, profile) {
  if (!pubkey) return null;

  const didDoc = {
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

  // Add services if available in profile content
  if (profile && profile.content) {
    try {
      const content = JSON.parse(profile.content);

      // Initialize service array if it doesn't exist
      if (!didDoc.service) {
        didDoc.service = [];
      }

      // Add Storage service if available
      if (content.storage || content.Storage) {
        const storageInfo = content.storage || content.Storage;

        didDoc.service.push({
          "id": `did:nostr:${pubkey}#storage`,
          "type": "Storage",
          "serviceEndpoint": typeof storageInfo === 'string' ? storageInfo : JSON.stringify(storageInfo)
        });
      }

      // Add Website service if available
      if (content.website) {
        didDoc.service.push({
          "id": `did:nostr:${pubkey}#website`,
          "type": ["Website", "LinkedDomains"],
          "serviceEndpoint": content.website
        });
      }
    } catch (error) {
      console.error(`Error parsing profile content for ${pubkey}:`, error);
    }
  }

  return didDoc;
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

  // Add created_at if it doesn't exist
  if (!event.created_at) {
    event.created_at = Math.floor(Date.now() / 1000); // Unix timestamp format
  }

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
            updated_at: data.updated_at || stats.mtime // Use existing updated_at or fallback to file mtime
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
      // First get all profiles without sorting
      const profiles = await beaconCollection
        .find({})
        .limit(limit * 2) // Get more than needed to account for sorting after fixing timestamps
        .toArray();

      // Ensure all profiles have an updated_at field
      for (const profile of profiles) {
        if (!profile.updated_at) {
          // If no updated_at, create one based on created_at or current time
          profile.updated_at = profile.created_at ?
            new Date(profile.created_at * 1000) :
            new Date();
        } else if (typeof profile.updated_at === 'string') {
          // Convert string timestamps to Date objects
          profile.updated_at = new Date(profile.updated_at);
        }
      }

      // Now sort by updated_at in memory
      return profiles
        .sort((a, b) => b.updated_at - a.updated_at)
        .slice(0, limit);
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
        const profile = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        // Ensure profile has updated_at field
        if (!profile.updated_at) {
          const stats = fs.statSync(filePath);
          profile.updated_at = profile.created_at ?
            new Date(profile.created_at * 1000) :
            stats.mtime;
        }
        return profile;
      } catch (error) {
        console.error(`Error reading profile for ${pubkey}:`, error);
        return null;
      }
    }
    return null;
  }
  else if (config.storage === 'mongodb') {
    try {
      const profile = await beaconCollection.findOne({ pubkey });
      // Ensure profile has updated_at field
      if (profile && !profile.updated_at) {
        profile.updated_at = profile.created_at ?
          new Date(profile.created_at * 1000) :
          new Date();
      }
      return profile;
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

  // Create a common CSS stylesheet for consistency
  const stylesPath = path.join(__dirname, 'public', 'styles.css');
  try {
    const cssContent = `:root {
  --color-bg: #f8f9fb;
  --color-card: #ffffff;
  --color-primary: #7a67ee;
  --color-primary-light: #a89ef5;
  --color-primary-subtle: #f3f1ff;
  --color-text: #394050;
  --color-text-secondary: #656d7e;
  --color-border: #e8ecf2;
  --color-did-bg: #edf7ff;
  --color-did-text: #1a85ca;
  --color-code-bg: #f5f7fa;
  --color-link: #7a67ee;
  --transition: all 0.3s ease;
  --shadow-sm: 0 2px 8px rgba(0,0,0,0.04);
  --shadow-md: 0 6px 14px rgba(0,0,0,0.06);
  --radius: 12px;
}

* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

body {
  font-family: 'Inter', system-ui, -apple-system, sans-serif;
  line-height: 1.5;
  background-color: var(--color-bg);
  color: var(--color-text);
  max-width: 900px;
  margin: 0 auto;
  padding: 40px 20px;
}

h1 {
  text-align: center;
  margin-bottom: 40px;
  font-weight: 700;
  font-size: 2.4rem;
  background: linear-gradient(135deg, var(--color-primary), var(--color-primary-light));
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  position: relative;
}

h1::after {
  content: "";
  position: absolute;
  width: 60px;
  height: 4px;
  bottom: -12px;
  left: 50%;
  transform: translateX(-50%);
  background: linear-gradient(135deg, var(--color-primary), var(--color-primary-light));
  border-radius: 2px;
}

.back-link {
  display: inline-flex;
  align-items: center;
  margin-bottom: 30px;
  text-decoration: none;
  color: var(--color-primary);
  font-weight: 500;
  transition: var(--transition);
  padding: 8px 16px;
  border-radius: 30px;
  background-color: var(--color-primary-subtle);
}

.back-link:hover {
  background-color: rgba(122, 103, 238, 0.15);
  transform: translateX(-3px);
}

.back-link::before {
  content: "←";
  margin-right: 8px;
  font-size: 1.2em;
}

@media (max-width: 768px) {
  body {
    padding: 20px 15px;
  }
  
  h1 {
    font-size: 2rem;
  }
}

/* Error page styles */
.error-container {
  background-color: var(--color-card);
  border-radius: var(--radius);
  box-shadow: var(--shadow-sm);
  padding: 60px 30px;
  margin-top: 40px;
  border: 1px solid var(--color-border);
  text-align: center;
}

.error-icon {
  font-size: 80px;
  margin-bottom: 20px;
  color: var(--color-primary-light);
  display: block;
}

.pubkey-container {
  background-color: rgba(0,0,0,0.03);
  border-radius: 8px;
  padding: 12px;
  font-family: monospace;
  margin-bottom: 30px;
  word-break: break-all;
}`;

    fs.writeFileSync(stylesPath, cssContent);
    console.log('Created/updated styles.css for consistent styling');
  } catch (error) {
    console.error('Error creating styles.css:', error);
  }

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
          <link rel="preconnect" href="https://fonts.googleapis.com">
          <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
          <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
          <link rel="stylesheet" href="/styles.css">
          <style>
            .profile-list {
              list-style: none;
              padding: 0;
              display: grid;
              grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
              gap: 20px;
            }
            
            .profile-item {
              border-radius: var(--radius);
              background-color: var(--color-card);
              border: 1px solid var(--color-border);
              box-shadow: var(--shadow-sm);
              transition: var(--transition);
              overflow: hidden;
            }
            
            .profile-item:hover {
              transform: translateY(-4px);
              box-shadow: var(--shadow-md);
              border-color: var(--color-primary-light);
            }
            
            .profile-link {
              display: block;
              text-decoration: none;
              color: inherit;
              padding: 20px;
            }
            
            .profile-header {
              display: flex;
              align-items: center;
              margin-bottom: 15px;
            }
            
            .profile-picture {
              width: 60px;
              height: 60px;
              border-radius: 50%;
              margin-right: 15px;
              object-fit: cover;
              background-color: #E0E0E0;
              display: flex;
              justify-content: center;
              align-items: center;
              overflow: hidden;
              border: 3px solid var(--color-primary-subtle);
              box-shadow: 0 2px 6px rgba(122, 103, 238, 0.2);
            }
            
            .profile-picture-initial {
              font-size: 24px;
              font-weight: bold;
              color: var(--color-primary);
              text-transform: uppercase;
            }
            
            .profile-info {
              flex: 1;
            }
            
            .profile-name {
              font-weight: 600;
              font-size: 1.1em;
              margin-bottom: 4px;
              color: var(--color-text);
              display: -webkit-box;
              -webkit-line-clamp: 1;
              -webkit-box-orient: vertical;
              overflow: hidden;
              text-overflow: ellipsis;
              text-align: left;
            }
            
            .profile-pubkey {
              font-family: monospace;
              color: var(--color-text-secondary);
              font-size: 0.8em;
              display: flex;
              align-items: center;
              margin-bottom: 4px;
            }
            
            .did-indicator {
              display: inline-block;
              background-color: var(--color-did-bg);
              color: var(--color-did-text);
              font-size: 0.75em;
              font-weight: 500;
              padding: 2px 8px;
              border-radius: 20px;
              margin-left: 6px;
              letter-spacing: 0.5px;
            }
            
            .updated-at {
              color: var(--color-text-secondary);
              font-size: 0.75em;
              margin-top: 2px;
            }
            
            @media (max-width: 768px) {
              .profile-list {
                grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
              }
            }
            
            @media (max-width: 480px) {
              .profile-list {
                grid-template-columns: 1fr;
              }
            }
          </style>
        </head>
        <body>
          <h1>Nostr Profiles</h1>
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
      let updatedText = '';
      let createdText = '';
      try {
        if (profile.updated_at) {
          const updatedDate = new Date(profile.updated_at);
          if (!isNaN(updatedDate.getTime())) {
            updatedText = `Updated: ${updatedDate.toLocaleString()}`;
          }
        }

        if (profile.created_at) {
          const createdDate = new Date(profile.created_at * 1000); // Convert Unix timestamp if needed
          if (!isNaN(createdDate.getTime())) {
            createdText = `Created: ${createdDate.toLocaleString()}`;
          }
        }
      } catch (e) {
        console.error('Date parsing error:', e);
      }

      return `
                <li class="profile-item">
                  <a href="/profile/${profile.pubkey}" class="profile-link">
                    <div class="profile-header">
                      <div class="profile-picture" style="background-color: ${bgColor};">
                        <img src="${picture}" style="width: 100%; height: 100%;" 
                            onerror="this.style.display='none'; this.parentNode.innerHTML = '<div class=\'profile-picture-initial\'>${initial}</div>';"
                            loading="lazy">
                      </div>
                      <div class="profile-info">
                        <p class="profile-name">${name}</p>
                        <p class="profile-pubkey">${profile.pubkey.substring(0, 8)}...
                          <span class="did-indicator" title="Decentralized Identifier">DID</span>
                        </p>
                      </div>
                    </div>
                    ${updatedText ? `<p class="updated-at">${updatedText}</p>` : ''}
                    ${createdText ? `<p class="updated-at">${createdText}</p>` : ''}
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
      return res.status(404).send(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>Profile Not Found - Nostr Beacon</title>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <link rel="preconnect" href="https://fonts.googleapis.com">
            <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
            <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
            <link rel="stylesheet" href="/styles.css">
            <style>
              body {
                text-align: center;
              }
            </style>
          </head>
          <body>
            <div class="error-container">
              <span class="error-icon">⚠️</span>
              <h1>Profile Not Found</h1>
              <p>We couldn't find a Nostr profile with the following public key:</p>
              <div class="pubkey-container">${req.params.pubkey}</div>
              <p>The profile may have been deleted or has not been added to this beacon yet.</p>
              <a href="/" class="back-link">Return to profiles</a>
            </div>
          </body>
        </html>
      `);
    }

    const content = profile.content ? JSON.parse(profile.content) : {};
    const name = content.name || content.display_name || 'Anonymous';

    // Validate picture URL for safety
    let picture = '/default-avatar.svg';
    if (content.picture && isValidImageUrl(content.picture)) {
      picture = content.picture;
    }

    // Validate banner URL for safety
    let banner = null;
    if (content.banner && isValidImageUrl(content.banner)) {
      banner = content.banner;
    }

    const initial = name.charAt(0);
    const bgColor = stringToColor(profile.pubkey);
    const about = content.about || 'No description provided';
    const website = content.website || '';
    const nip05 = content.nip05 || '';
    const storage = content.storage || content.Storage || '';

    // Fix for date display
    let createdText = 'Unknown date';
    let updatedText = 'Unknown date';
    try {
      if (profile.created_at) {
        const createdDate = new Date(profile.created_at * 1000); // Convert Unix timestamp
        if (!isNaN(createdDate.getTime())) {
          createdText = createdDate.toLocaleString();
        }
      }

      if (profile.updated_at) {
        const updatedDate = new Date(profile.updated_at);
        if (!isNaN(updatedDate.getTime())) {
          updatedText = updatedDate.toLocaleString();
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
          <link rel="preconnect" href="https://fonts.googleapis.com">
          <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
          <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
          <link rel="stylesheet" href="/styles.css">
          <style>
            .profile-card {
              background-color: var(--color-card);
              border-radius: var(--radius);
              box-shadow: var(--shadow-sm);
              overflow: hidden;
              border: 1px solid var(--color-border);
              margin-bottom: 30px;
            }
            
            .profile-banner {
              width: 100%;
              height: 200px;
              object-fit: cover;
              margin-bottom: -30px;
            }
            
            .profile-header {
              padding: 30px;
              display: flex;
              align-items: center;
              border-bottom: 1px solid var(--color-border);
            }
            
            .profile-picture {
              width: 120px;
              height: 120px;
              border-radius: 50%;
              margin-right: 30px;
              object-fit: cover;
              background-color: #E0E0E0;
              display: flex;
              justify-content: center;
              align-items: center;
              overflow: hidden;
              border: 4px solid var(--color-primary-subtle);
              box-shadow: 0 3px 10px rgba(122, 103, 238, 0.2);
            }
            
            .profile-picture-initial {
              font-size: 48px;
              font-weight: bold;
              color: var(--color-primary);
              text-transform: uppercase;
            }
            
            .profile-title {
              flex: 1;
            }
            
            .profile-name {
              font-size: 2.2em;
              font-weight: 700;
              margin: 0 0 8px 0;
              color: var(--color-text);
              text-align: left;
            }
            
            .profile-pubkey {
              font-family: monospace;
              word-break: break-all;
              color: var(--color-text-secondary);
              font-size: 0.9em;
              background-color: var(--color-code-bg);
              padding: 6px 12px;
              border-radius: 6px;
              display: inline-block;
              margin-top: 2px;
            }
            
            .profile-links {
              margin-top: 15px;
            }
            
            .nostr-link {
              display: inline-flex;
              align-items: center;
              padding: 10px 16px;
              background-color: #8867ff;
              color: white;
              text-decoration: none;
              font-size: 0.95em;
              font-weight: 600;
              border-radius: 20px;
              transition: all 0.3s ease;
              box-shadow: 0 2px 8px rgba(136, 103, 255, 0.3);
            }
            
            .nostr-link:hover {
              background-color: #7a5cf0;
              transform: translateY(-2px);
              box-shadow: 0 4px 12px rgba(136, 103, 255, 0.4);
            }
            
            .nostr-link::before {
              content: "⚡";
              margin-right: 8px;
              font-size: 1.1em;
            }
            
            .profile-section {
              padding: 30px;
              border-bottom: 1px solid var(--color-border);
            }
            
            .profile-section:last-child {
              border-bottom: none;
            }
            
            .profile-section h2 {
              font-size: 1.4em;
              font-weight: 600;
              margin-bottom: 15px;
              color: var(--color-primary);
              display: flex;
              align-items: center;
            }
            
            .profile-section h2::before {
              content: "";
              display: inline-block;
              width: 5px;
              height: 20px;
              background-color: var(--color-primary);
              margin-right: 10px;
              border-radius: 3px;
            }
            
            .profile-section p {
              margin-bottom: 15px;
              line-height: 1.7;
            }
            
            .metadata {
              display: grid;
              grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
              gap: 20px;
            }
            
            .metadata-item {
              margin-bottom: 20px;
            }
            
            .metadata-label {
              font-weight: 500;
              color: var(--color-text-secondary);
              margin-bottom: 5px;
              font-size: 0.9em;
              text-transform: uppercase;
              letter-spacing: 0.5px;
            }
            
            .metadata-value {
              font-size: 1em;
              word-break: break-all;
            }
            
            .metadata-value a {
              color: var(--color-link);
              text-decoration: none;
              border-bottom: 1px solid transparent;
              transition: var(--transition);
            }
            
            .metadata-value a:hover {
              border-bottom-color: var(--color-primary);
            }
            
            .did-section {
              background-color: var(--color-code-bg);
              border-radius: var(--radius);
              padding: 20px;
            }
            
            pre {
              background: var(--color-code-bg);
              padding: 20px;
              overflow: auto;
              border-radius: var(--radius);
              font-size: 0.9em;
              color: var(--color-text);
              border: 1px solid var(--color-border);
            }
            
            .api-links {
              display: flex;
              flex-wrap: wrap;
              gap: 10px;
              margin-top: 15px;
            }
            
            .api-link {
              display: inline-flex;
              align-items: center;
              padding: 8px 15px;
              background-color: var(--color-primary-subtle);
              color: var(--color-primary);
              text-decoration: none;
              font-size: 0.9em;
              font-weight: 500;
              border-radius: 20px;
              transition: var(--transition);
            }
            
            .api-link:hover {
              background-color: var(--color-primary);
              color: white;
              transform: translateY(-2px);
            }
            
            @media (max-width: 768px) {
              .profile-header {
                flex-direction: column;
                text-align: center;
              }
              
              .profile-picture {
                margin-right: 0;
                margin-bottom: 20px;
              }
              
              .metadata {
                grid-template-columns: 1fr;
              }
            }
          </style>
        </head>
        <body>
          <a href="/" class="back-link">Back to profiles</a>
          
          <div class="profile-card">
            ${banner ? `<img src="${banner}" alt="Profile Banner" class="profile-banner">` : ''}
            <div class="profile-header">
              <div class="profile-picture" style="background-color: ${bgColor};">
                <img src="${picture}" style="width: 100%; height: 100%;" 
                    onerror="this.style.display='none'; this.parentNode.innerHTML = '<div class=\'profile-picture-initial\'>${initial}</div>';"
                    loading="lazy">
              </div>
              <div class="profile-title">
                <h1 class="profile-name">${name}</h1>
                <div class="profile-pubkey">${profile.pubkey}</div>
                <div class="profile-links">
                  <a href="https://nostr.rocks/users/${profile.pubkey}" target="_blank" class="nostr-link">View on Nostr</a>
                </div>
              </div>
            </div>
            
            <div class="profile-section">
              <h2>About</h2>
              <p>${about}</p>
            </div>
            
            <div class="profile-section">
              <h2>Metadata</h2>
              <div class="metadata">
                ${website ? `
                <div class="metadata-item">
                  <div class="metadata-label">Website</div>
                  <div class="metadata-value"><a href="${website}" target="_blank">${website}</a></div>
                </div>` : ''}
                
                ${nip05 ? `
                <div class="metadata-item">
                  <div class="metadata-label">NIP-05</div>
                  <div class="metadata-value">${nip05}</div>
                </div>` : ''}
                
                ${storage ? `
                <div class="metadata-item">
                  <div class="metadata-label">Storage</div>
                  <div class="metadata-value"><a href="${typeof storage === 'string' ? storage :
          (Array.isArray(storage) && storage.length > 0 && typeof storage[0] === 'string' ? storage[0] : '#')
        }" target="_blank">${typeof storage === 'string' ? storage :
          (Array.isArray(storage) && storage.length > 0 && typeof storage[0] === 'string' ? storage[0] : JSON.stringify(storage))
        }</a></div>
                </div>` : ''}
                
                <div class="metadata-item">
                  <div class="metadata-label">Created</div>
                  <div class="metadata-value">${createdText}</div>
                </div>
                
                <div class="metadata-item">
                  <div class="metadata-label">Updated</div>
                  <div class="metadata-value">${updatedText}</div>
                </div>
                
                <div class="metadata-item">
                  <div class="metadata-label">Nostr DID</div>
                  <div class="metadata-value">did:nostr:${profile.pubkey}</div>
                </div>
                
                <div class="metadata-item">
                  <div class="metadata-label">Nostr Feed</div>
                  <div class="metadata-value"><a href="https://nostr.rocks/users/${profile.pubkey}" target="_blank">nostr.rocks/users/${profile.pubkey.substring(0, 8)}...</a></div>
                </div>
              </div>
            </div>
            
            <div class="profile-section">
              <h2>DID Document</h2>
              <div class="did-section">
                <pre>${JSON.stringify(generateDidDocument(profile.pubkey, profile), null, 2)}</pre>
                <div class="api-links">
                  <a href="/api/did/${profile.pubkey}" target="_blank" class="api-link">View as JSON API endpoint</a>
                  <a href="/.well-known/did/nostr/${profile.pubkey}.json" target="_blank" class="api-link">View as standardized DID document</a>
                </div>
              </div>
            </div>
            
            <div class="profile-section">
              <h2>Raw JSON</h2>
              <pre>${JSON.stringify(profile, null, 2)}</pre>
            </div>
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
    // Fetch the profile first
    const profile = await getProfile(pubkey);
    const didDocument = generateDidDocument(pubkey, profile);

    if (!didDocument) {
      return res.status(404).json({ error: 'Could not generate DID document' });
    }

    res.json(didDocument);
  });

  // Standard DID Document endpoint according to DID specification
  app.get('/.well-known/did/nostr/:pubkey.json', async (req, res) => {
    const pubkey = req.params.pubkey;
    // Fetch the profile first
    const profile = await getProfile(pubkey);
    const didDocument = generateDidDocument(pubkey, profile);

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
        const didDoc = generateDidDocument(profile.pubkey, profile);
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