// Connect to the signaling server
const socket = io('http://localhost:5500', {
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 1000
});

// DOM elements
const usernameInput = document.getElementById('username');
const roomNameInput = document.getElementById('room-name');
const createButton = document.getElementById('create-btn');
const joinButton = document.getElementById('join-btn');
const disconnectButton = document.getElementById('disconnect-btn');
const connectionForm = document.querySelector('.connection-form');
const roomInfo = document.getElementById('room-info');
const currentRoomSpan = document.getElementById('current-room');
const usersList = document.getElementById('users-list');
const virtualIpSpan = document.getElementById('virtual-ip');
const connectionTypeSpan = document.getElementById('connection-type');
const latencySpan = document.getElementById('latency');
const packetLossSpan = document.getElementById('packet-loss');

// Store peer connections
const peers = {};
let currentRoom = null;
let localUsername = null;
// Track pending signals to handle race conditions
const pendingSignals = {};
// Track if we're in serverless mode
let serverlessMode = false;

// Generate a random virtual IP in the 10.0.0.x range
function generateVirtualIP() {
    return `10.0.0.${Math.floor(Math.random() * 253) + 1}`;
}

// Initialize peer connection with another user
function initPeer(targetId, isInitiator) {
    console.log(`Initializing peer connection with ${targetId}, initiator: ${isInitiator}`);
    
    // Create new peer connection with negotiation disabled to prevent race conditions
    const peer = new SimplePeer({
        initiator: isInitiator,
        trickle: true,
        sdpTransform: (sdp) => {
            console.log(`SDP created, type: ${isInitiator ? 'offer' : 'answer'}`);
            return sdp;
        }
    });

    // Handle signals
    peer.on('signal', signal => {
        console.log(`Sending signal to ${targetId}, type: ${signal.type || 'candidate'}`);
        socket.emit('signal', {
            to: targetId,
            signal: signal
        });
    });

    // Handle connection established
    peer.on('connect', () => {
        console.log(`Connected to peer ${targetId}`);
        connectionTypeSpan.textContent = 'Peer-to-peer';
        
        // Send our username to the peer once connected
        peer.send(JSON.stringify({
            type: 'metadata',
            username: localUsername,
            id: socket.id
        }));
        
        // Process any pending signals
        if (pendingSignals[targetId] && pendingSignals[targetId].length > 0) {
            console.log(`Processing ${pendingSignals[targetId].length} pending signals for ${targetId}`);
            pendingSignals[targetId].forEach(signal => {
                try {
                    peer.signal(signal);
                } catch (err) {
                    console.error('Error processing pending signal:', err);
                }
            });
            delete pendingSignals[targetId];
        }
        
        // Start latency measurements
        startLatencyMeasurements(peer, targetId);
    });

    // Handle data received
    peer.on('data', data => {
        try {
            const message = JSON.parse(data);
            
            if (message.type === 'ping') {
                // Respond to ping
                peer.send(JSON.stringify({
                    type: 'pong',
                    timestamp: message.timestamp
                }));
            } else if (message.type === 'pong') {
                // Calculate latency
                const latency = Date.now() - message.timestamp;
                latencySpan.textContent = `${latency}ms`;
            } else if (message.type === 'gamePacket') {
                // Handle game data packets
                console.log('Received game packet:', message.data);
                // This is where we'd process game-specific packets
            } else if (message.type === 'metadata') {
                // Store peer metadata for serverless mode
                if (!peers[targetId].metadata) {
                    peers[targetId].metadata = {
                        username: message.username,
                        id: message.id
                    };
                    
                    // If in serverless mode, update the UI
                    if (serverlessMode) {
                        updateUsersListServerless();
                    }
                }
            } else if (message.type === 'serverless-user-joined') {
                // Handle new user in serverless mode
                console.log('Serverless: User joined notification from peer');
                
                // Connect to the new user if we don't have a connection yet
                if (!peers[message.user.id] && message.user.id !== socket.id) {
                    // Use deterministic initiator selection
                    const shouldInitiate = socket.id.localeCompare(message.user.id) > 0;
                    peers[message.user.id] = initPeer(message.user.id, shouldInitiate);
                    
                    // Store metadata
                    peers[message.user.id].metadata = {
                        username: message.user.username,
                        id: message.user.id
                    };
                }
                
                // Update UI
                if (serverlessMode) {
                    updateUsersListServerless();
                }
            } else if (message.type === 'serverless-user-left') {
                // Handle user leaving in serverless mode
                console.log('Serverless: User left notification from peer');
                
                // Close connection if exists
                if (peers[message.userId]) {
                    peers[message.userId].destroy();
                    delete peers[message.userId];
                }
                
                // Update UI
                if (serverlessMode) {
                    updateUsersListServerless();
                }
            }
        } catch (err) {
            console.error('Error parsing peer data:', err);
        }
    });

    // Handle peer errors with improved error handling
    peer.on('error', err => {
        console.error('Peer connection error:', err);
        connectionTypeSpan.textContent = 'Relay (fallback)';
        
        // If we get an invalid state error, destroy and recreate the peer
        if (err.message && err.message.includes('InvalidStateError')) {
            console.log('Invalid state detected, destroying peer connection');
            if (peers[targetId]) {
                // Remove the peer before recreating to avoid state conflicts
                const oldPeer = peers[targetId];
                delete peers[targetId];
                
                // Destroy the peer properly
                try {
                    oldPeer.destroy();
                } catch (e) {
                    console.error('Error destroying peer:', e);
                }
                
                // Wait before recreating to ensure clean state
                setTimeout(() => {
                    console.log('Recreating peer connection with opposite initiator state');
                    // Create with opposite initiator state to avoid collision
                    if (!peers[targetId]) {
                        peers[targetId] = initPeer(targetId, !isInitiator);
                    }
                }, 2000);
            }
        }
    });

    // Handle peer close
    peer.on('close', () => {
        console.log(`Connection to peer ${targetId} closed`);
        delete peers[targetId];
    });

    return peer;
}

// Process incoming signal with improved state handling
function processSignal(from, signal) {
    console.log(`Processing signal from ${from}, type: ${signal.type || 'candidate'}`);
    
    // Special handling for offer/answer to prevent collisions
    if (signal.type === 'offer') {
        // If we receive an offer and we're also trying to create an offer,
        // destroy our peer if it exists and create a new one as non-initiator
        if (peers[from] && peers[from]._initiator) {
            console.log('Offer collision detected, recreating as non-initiator');
            const oldPeer = peers[from];
            delete peers[from];
            
            try {
                oldPeer.destroy();
            } catch (e) {
                console.error('Error destroying peer during offer collision:', e);
            }
            
            // Create new peer as non-initiator
            peers[from] = initPeer(from, false);
        } else if (!peers[from]) {
            // Normal case - create new peer as non-initiator
            console.log(`Creating new peer for ${from} (non-initiator)`);
            peers[from] = initPeer(from, false);
        }
    }
    
    // If we don't have a peer yet for non-offer signals, create one
    if (!peers[from] && signal.type !== 'offer') {
        console.log(`Creating new peer for ${from} (non-initiator) for non-offer signal`);
        peers[from] = initPeer(from, false);
    }
    
    // Add delay for applying the signal to ensure proper state
    setTimeout(() => {
        try {
            // Try to apply the signal
            if (peers[from]) {
                peers[from].signal(signal);
            }
        } catch (err) {
            console.error('Error applying signal:', err);
            
            // If we get an error, queue the signal for later
            if (!pendingSignals[from]) {
                pendingSignals[from] = [];
            }
            console.log(`Queuing signal from ${from} for later processing`);
            pendingSignals[from].push(signal);
            
            // If it's an invalid state error, recreate the peer
            if (err.message && err.message.includes('InvalidStateError')) {
                console.log('Invalid state detected during signal processing');
                if (peers[from]) {
                    const oldPeer = peers[from];
                    delete peers[from];
                    
                    try {
                        oldPeer.destroy();
                    } catch (e) {
                        console.error('Error destroying peer during signal error:', e);
                    }
                    
                    // Wait before recreating
                    setTimeout(() => {
                        if (!peers[from]) {
                            // Create with opposite initiator state
                            const wasInitiator = oldPeer._initiator;
                            peers[from] = initPeer(from, !wasInitiator);
                        }
                    }, 2000);
                }
            }
        }
    }, 100); // Small delay to ensure proper state
}

// Measure latency periodically
function startLatencyMeasurements(peer, targetId) {
    // Send a ping every 2 seconds
    setInterval(() => {
        if (peer.connected) {
            peer.send(JSON.stringify({
                type: 'ping',
                timestamp: Date.now()
            }));
        }
    }, 2000);
}

// Update the users list in the UI with improved peer creation
function updateUsersList(users) {
    usersList.innerHTML = '';
    
    Object.values(users).forEach(user => {
        const li = document.createElement('li');
        li.textContent = `${user.username} ${user.id === socket.id ? '(You)' : ''}`;
        usersList.appendChild(li);
        
        // Connect to new peers if needed with negotiation protection
        if (user.id !== socket.id && !peers[user.id]) {
            // Use a deterministic way to decide who initiates to prevent both sides initiating
            const shouldInitiate = socket.id.localeCompare(user.id) > 0;
            console.log(`Creating peer connection with ${user.id}, initiator: ${shouldInitiate}`);
            peers[user.id] = initPeer(user.id, shouldInitiate);
        }
    });
}

// Show room info and hide connection form
function showRoomInfo(roomName) {
    connectionForm.style.display = 'none';
    roomInfo.style.display = 'block';
    currentRoomSpan.textContent = roomName;
    currentRoom = roomName;
    
    // Assign virtual IP
    const virtualIP = generateVirtualIP();
    virtualIpSpan.textContent = virtualIP;
}

// Handle create room button click
createButton.addEventListener('click', () => {
    const username = usernameInput.value.trim();
    const roomName = roomNameInput.value.trim();
    
    if (username && roomName) {
        localUsername = username;
        socket.emit('create-room', roomName, username);
    }
});

// Handle join room button click
joinButton.addEventListener('click', () => {
    const username = usernameInput.value.trim();
    const roomName = roomNameInput.value.trim();
    
    if (username && roomName) {
        localUsername = username;
        socket.emit('join-room', roomName, username);
    }
});

// Handle disconnect button click with improved cleanup
disconnectButton.addEventListener('click', () => {
    // Close all peer connections
    Object.keys(peers).forEach(peerId => {
        try {
            if (peers[peerId]) {
                peers[peerId].destroy();
            }
        } catch (e) {
            console.error(`Error destroying peer ${peerId}:`, e);
        }
    });
    
    // Clear peers object
    Object.keys(peers).forEach(key => delete peers[key]);
    
    // Clear any pending signals
    Object.keys(pendingSignals).forEach(key => delete pendingSignals[key]);
    
    // Show connection form again
    connectionForm.style.display = 'block';
    roomInfo.style.display = 'none';
    
    // Leave the room
    if (currentRoom) {
        socket.emit('leave-room', currentRoom);
        currentRoom = null;
    }
    
    // Reset network stats
    connectionTypeSpan.textContent = '-';
    latencySpan.textContent = '-';
    packetLossSpan.textContent = '-';
});

// Socket.io event handlers
socket.on('room-created', roomName => {
    console.log(`Room created: ${roomName}`);
    showRoomInfo(roomName);
});

socket.on('room-joined', roomName => {
    console.log(`Room joined: ${roomName}`);
    showRoomInfo(roomName);
});

socket.on('user-joined', data => {
    console.log('User joined, updating users list:', data.users);
    updateUsersList(data.users);
});

socket.on('user-left', data => {
    console.log('User left:', data.userId);
    
    // Close peer connection if exists
    if (peers[data.userId]) {
        peers[data.userId].destroy();
        delete peers[data.userId];
    }
    
    // Update users list
    if (data.users) {
        updateUsersList(data.users);
    }
});

socket.on('signal', data => {
    const { from, signal } = data;
    console.log(`Received signal from ${from}`, signal.type);
    processSignal(from, signal);
});

socket.on('error', message => {
    alert(`Error: ${message}`);
});

// Game launching functionality
document.querySelectorAll('.game-item').forEach(item => {
    item.addEventListener('click', () => {
        const game = item.getAttribute('data-game');
        alert(`Launching ${game}... (This would open the actual game in a real implementation)`);
        
        // In a real implementation, we would:
        // 1. Launch the game with appropriate network settings
        // 2. Hook into the game's network traffic
        // 3. Route that traffic through our virtual network
    });
});

// Update packet loss randomly for demo purposes
setInterval(() => {
    if (currentRoom) {
        const randomLoss = (Math.random() * 2).toFixed(1);
        packetLossSpan.textContent = `${randomLoss}%`;
    }
}, 5000);

// Add connection status logging
socket.on('connect', () => {
    console.log('Connected to server with ID:', socket.id);
});

socket.on('connect_error', (error) => {
    console.error('Connection error:', error);
});


// Handle server disconnect
socket.on('disconnect', () => {
    console.log('Disconnected from server');
    
    // Only enter serverless mode if we were in a room
    if (currentRoom) {
        enterServerlessMode();
    }
});