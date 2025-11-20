require('dotenv').config(); // Load environment variables
const express = require('express');
const http = require('http');
const { WebSocket, WebSocketServer } = require('ws');
const path = require('path');
// It's best practice to load dotenv first, then require modules that depend on it.
// This ensures that when firebase.js is imported, process.env is already populated.
const { db } = require('./firebase'); // Use Firebase


const app = express();
const server = http.createServer(app);

// Use a dynamic port from the environment or default to 3000
const PORT = process.env.PORT || 3000;

// Middleware to parse JSON bodies
app.use(express.json({ limit: '10mb' })); // Increase limit for images

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// WebSocket server setup
const wss = new WebSocketServer({ server });

// Map to store clients and their associated user
const clients = new Map(); // Now stores: Map<string, Set<WebSocket>>

const broadcast = (message) => {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(message);
    });
};

wss.on('connection', (ws) => {
    console.log('Client connected');

    ws.on('message', (rawMessage) => {
        const data = JSON.parse(rawMessage.toString());
        // Handle user registration on login
        if (data.type === 'register') {
            const user = data.payload.user;
            ws.user = user; // Associate user with this WebSocket connection

            // If the user is connecting for the first time, create a new Set
            if (!clients.has(user)) {
                clients.set(user, new Set());
            }
            // Add the new connection to the user's Set of connections
            clients.get(user).add(ws);
            console.log(`User '${user}' registered a new connection. Total connections for user: ${clients.get(user).size}`);

            // Notify all clients that this user is now online
            broadcast(JSON.stringify({ type: 'user_status', payload: { user, status: 'online' } }));
            return; // Stop processing after registration
        }
            

        // --- WebRTC Signaling and General Message Forwarding ---
        // For signaling, typing, etc., broadcast to all clients except the sender.
        // The client-side logic will determine if the message is relevant.
        // This is simpler than routing every single message type on the server.
        wss.clients.forEach((client) => {
            // Do not send the message back to the original sender.
            // This handles general broadcasts like typing indicators.
            if (client !== ws && client.readyState === WebSocket.OPEN) {
                client.send(rawMessage.toString());
             }
        });
    });

    ws.on('close', () => {
        console.log('Client disconnected');
        // Remove user from the clients map on disconnect
        if (ws.user) {
            const disconnectedUser = ws.user; // Get the user before deleting
            const userConnections = clients.get(disconnectedUser);

            if (userConnections) {
                userConnections.delete(ws); // Remove the specific connection that closed
                console.log(`User '${disconnectedUser}' connection closed. Remaining connections: ${userConnections.size}`);
                // If that was the last connection for the user, clear the entry from the map
                if (userConnections.size === 0) {
                    clients.delete(disconnectedUser);
                }
            }

            // Wait for a short period before broadcasting the offline status.
            // This gives the client a chance to reconnect without appearing offline.
            setTimeout(() => {
                if (!clients.has(disconnectedUser)) {
                    console.log(`User '${disconnectedUser}' is now offline.`);
                    const offlineMessage = JSON.stringify({ type: 'user_status', payload: { user: disconnectedUser, status: 'offline' } });
                    const peerDisconnectedMessage = JSON.stringify({ type: 'peer-disconnected', payload: { user: disconnectedUser } });
                    broadcast(offlineMessage);
                    broadcast(peerDisconnectedMessage);
                }
            }, 5000); // 5-second grace period for reconnection.
        }
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});

// API to get all messages
app.get('/api/messages', async (req, res) => {
    try {
        const alphaRef = db.ref('alpha_messages');
        const betaRef = db.ref('beta_messages');

        const alphaSnapshot = await alphaRef.orderByChild('created_at').once('value');
        const betaSnapshot = await betaRef.orderByChild('created_at').once('value');

        const alphaMessages = alphaSnapshot.val() || {};
        const betaMessages = betaSnapshot.val() || {};

        // Convert messages from both paths into a single array
        const allMessages = [
            ...Object.keys(alphaMessages).map(key => ({ id: key, ...alphaMessages[key] })),
            ...Object.keys(betaMessages).map(key => ({ id: key, ...betaMessages[key] }))
        ];

        // Sort the combined array by the created_at timestamp
        allMessages.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

        res.json(allMessages);
    } catch (err) {
        console.error('Error fetching messages:', err);
        res.status(500).send('Server Error');
    }
});

// API to post a new message
app.post('/api/messages', async (req, res) => {
    const { sender, recipient, content, timeString, reply_to_id } = req.body;
    try {
        // Determine the correct database path based on the sender
        const path = sender === 'alpha' ? 'alpha_messages' : 'beta_messages';
        const messagesRef = db.ref(path);
        const newMessageRef = messagesRef.push(); // Generate a unique, time-ordered key

        // Ensure recipient is never undefined. Fallback logic.
        const messageData = {
            sender,
            recipient: recipient || (sender === 'alpha' ? 'beta' : 'alpha'),
            content,
            time_string: timeString,
            reply_to_id: reply_to_id || null,
            is_seen: false,
            seen_at: null,
            created_at: new Date().toISOString()
        };

        await newMessageRef.set(messageData);

        const newMessage = { id: newMessageRef.key, ...messageData };

        // Broadcast the new message to all connected WebSocket clients
        broadcast(JSON.stringify({ type: 'new_message', payload: newMessage }));

        res.status(201).json(newMessage); // Respond with the created message
    } catch (err) {
        console.error('Error posting message:', err);
        res.status(500).json({ error: 'Failed to save message', details: err.message });
    }
});

// API to get unread message count for a user
app.get('/api/messages/unread-count', async (req, res) => {
    const { user } = req.query; // e.g., 'alpha' or 'beta'
    if (!user) {
        return res.status(400).json({ error: 'User query parameter is required.' });
    }

    // If user is 'alpha', count unread messages sent by 'beta'.
    const path = user === 'alpha' ? 'beta_messages' : 'alpha_messages';
    const messagesRef = db.ref(path);

    try {
        const snapshot = await messagesRef.orderByChild('is_seen').equalTo(false).once('value');
        const unreadMessages = snapshot.val();
        const count = unreadMessages ? Object.keys(unreadMessages).length : 0;
        res.json({ count });
    } catch (err) {
        console.error('Error fetching unread count:', err);
        res.status(500).json({ error: 'Failed to fetch unread count' });
    }
});

// API to mark messages as seen
app.post('/api/messages/mark-as-seen', async (req, res) => {
    const { user } = req.body; // The user who is currently viewing the chat
    if (!user) {
        return res.status(400).json({ error: 'User is required in the request body.' });
    }

    // If 'alpha' is viewing, mark messages sent by 'beta' as seen.
    const path = user === 'alpha' ? 'beta_messages' : 'alpha_messages';
    const messagesRef = db.ref(path);

    try {
        const snapshot = await messagesRef.orderByChild('is_seen').equalTo(false).once('value');
        const messagesToUpdate = snapshot.val();

        if (!messagesToUpdate) {
            return res.status(200).json([]); // Nothing to update
        }

        const updates = {};
        const seenAtTimestamp = new Date().toISOString();
        const seenMessagesPayload = [];

        Object.keys(messagesToUpdate).forEach(key => {
            updates[`/${key}/is_seen`] = true;
            updates[`/${key}/seen_at`] = seenAtTimestamp;
            // Prepare payload for broadcasting
            seenMessagesPayload.push({ 
                id: key, 
                ...messagesToUpdate[key], 
                is_seen: true, 
                seen_at: seenAtTimestamp 
            });
        });

        if (Object.keys(updates).length > 0) {
            await messagesRef.update(updates);
        }

        // Broadcast the full list of seen messages to all clients.
        broadcast(JSON.stringify({ type: 'messages_seen', payload: seenMessagesPayload }));
        res.status(200).json(seenMessagesPayload);
    } catch (err) {
        console.error('Error marking messages as seen:', err);
        res.status(500).json({ error: 'Failed to update messages' });
    }
});

// API to clear all messages
app.delete('/api/messages', async (req, res) => {
    try {
        // Remove both message paths from Firebase
        await db.ref('alpha_messages').remove();
        await db.ref('beta_messages').remove();
        console.log('Chat history cleared from database.');

        // Broadcast a clear event to all connected clients
        broadcast(JSON.stringify({ type: 'chat_cleared' }));

        res.status(204).send(); // 204 No Content is a standard success response for DELETE
    } catch (err) {
        console.error('Error clearing chat history:', err);
        res.status(500).send('Server Error');
    }
});

app.get('/', (req, res) => {
    // This route serves the main HTML file
    res.sendFile(path.join(__dirname, 'public', 'index.html')); 
});

const startServer = async () => {
    try {
        // Firebase is initialized in firebase.js, no table creation needed.
        // Log the environment for easier debugging on deployment platforms
        if (process.env.NODE_ENV === 'production') {
            console.log('Server starting in production mode...');
        } else {
            console.log('Server starting in development mode...');
        }

        server.listen(PORT, () => {
            console.log(`Server is listening on http://localhost:${PORT}`);
        });
    } catch (err) {
        console.error('Failed to start server:', err);
        process.exit(1);
    }
};

startServer();