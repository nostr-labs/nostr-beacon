# Nostr Profile Beacon

A web server that displays the 10 most recently updated Nostr profiles, with the ability to view individual profile details.

## Features

- View a list of the 10 most recently updated Nostr profiles
- Click on profiles to view detailed information
- Supports both file-based and MongoDB storage options
- RESTful API endpoints for accessing profile data

## Installation

1. Clone the repository
2. Install dependencies:

```
npm install
```

## Configuration

The application can be configured using environment variables:

- `PORT`: Server port (default: 3000)
- `STORAGE_TYPE`: Storage backend to use, either 'file' or 'mongodb' (default: 'file')
- `MONGO_URL`: MongoDB connection URL (default: 'mongodb://localhost:27017')
- `MONGO_DB`: MongoDB database name (default: 'nostr')
- `MONGO_COLLECTION`: MongoDB collection name (default: 'beacon')

## Running the Application

Start the server:

```
node server.js
```

Then visit `http://localhost:3000` in your browser to see the list of profiles.

## API Endpoints

- `GET /api/profiles` - Get a list of recent profiles (JSON)
- `GET /api/profile/:pubkey` - Get a specific profile by pubkey (JSON)

## Storage

### File Storage

When using file storage (default), profiles are stored as JSON files in the `data/` directory.

### MongoDB Storage

When using MongoDB storage, make sure to set the proper environment variables and ensure MongoDB is running.

## Adding Profiles

This application no longer subscribes to the Nostr firehose. To add profiles, you can:

1. Use the MongoDB or file-based storage directly
2. Implement an event subscriber separately
3. Use the API endpoints (forthcoming feature)

## License

MIT
