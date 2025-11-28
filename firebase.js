const admin = require('firebase-admin');

// This single try-catch block will handle initialization.
// Your server.js loads dotenv, so the environment variables are available here.
try {
    // Explicitly check for the environment variable.
    let serviceAccount;
    if (process.env.FIREBASE_CREDENTIALS_JSON) {
        // For production environments like Render, parse the JSON from the environment variable.
        serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS_JSON);
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        // For local development, use the file path.
        serviceAccount = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    } else {
        throw new Error('Firebase credentials not found. Please set FIREBASE_CREDENTIALS_JSON or GOOGLE_APPLICATION_CREDENTIALS environment variables.');
    }

    // Explicitly use the service account key from the path in the environment variable.
    // This is more robust than relying on automatic discovery.
    // Check if the app is already initialized to prevent errors on hot-reloads
    if (!admin.apps.length) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: process.env.FIREBASE_DATABASE_URL
        });
    }
    console.log('Firebase Admin SDK initialized successfully.');
} catch (error) {
    console.error('Error initializing Firebase Admin SDK. Please ensure:');
    console.error('1. For local development, the .env file has a valid GOOGLE_APPLICATION_CREDENTIALS path.');
    console.error('2. For production (like Render), the FIREBASE_CREDENTIALS_JSON environment variable is set with the JSON content.');
    console.error('3. The FIREBASE_DATABASE_URL is correctly set.');
    console.error('Original Error:', error);
    process.exit(1);
}

// Export the database instance for use in other files.
module.exports = { db: admin.database() };