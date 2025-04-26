import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';

// Get current directory (ES Module equivalent of __dirname)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create express app and server
const app = express();
const server = createServer(app);
const io = new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Add JSON parsing middleware
app.use(express.json());

// Store connected users
const rooms = {};

// API endpoint to get all rooms
app.get('/api/rooms', (req, res) => {
  const roomList = Object.keys(rooms).map(roomName => {
    return {
      name: roomName,
      userCount: Object.keys(rooms[roomName].users).length,
      host: rooms[roomName].host
    };
  });
  
  res.json({ rooms: roomList });
});

io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);
  
  // User creates a new virtual LAN
  socket.on('create-room', (roomName, username) => {
    if(!roomName || !username){
      socket.emit('error', 'Invalid room name or username');
      return;
    }
    console.log(`${username} created room: ${roomName}`);
    
    // Create room if it doesn't exist
    if (!rooms[roomName]) {
      rooms[roomName] = {
        users: {},
        host: socket.id
      };
    }
    
    // Add user to room
    rooms[roomName].users[socket.id] = {
      id: socket.id,
      username: username,
      peerId: null
    };
    
    socket.join(roomName);
    socket.roomName = roomName;
    
    // Notify user of successful room creation
    socket.emit('room-created', roomName);
    io.to(roomName).emit('user-joined', {
      users: rooms[roomName].users,
      host: rooms[roomName].host
    });
    
    // Broadcast updated room list to all connected clients
    io.emit('rooms-list-updated', Object.keys(rooms));
  });
  
  // User joins an existing virtual LAN
  socket.on('join-room', (roomName, username) => {
    console.log(`${username} joined room: ${roomName}`);
    
    if (!rooms[roomName]) {
      socket.emit('error', 'Room does not exist');
      return;
    }
    
    // Add user to room
    rooms[roomName].users[socket.id] = {
      id: socket.id,
      username: username,
      peerId: null
    };
    
    socket.join(roomName);
    socket.roomName = roomName;
    
    // Notify everyone in the room of the new user
    socket.emit('room-joined', roomName);
    io.to(roomName).emit('user-joined', {
      users: rooms[roomName].users,
      host: rooms[roomName].host
    });
  });
  
  // Get available rooms
  socket.on('get-rooms', () => {
    const roomList = Object.keys(rooms).map(roomName => {
      return {
        name: roomName,
        userCount: Object.keys(rooms[roomName].users).length,
        host: rooms[roomName].host
      };
    });
    
    socket.emit('rooms-list', roomList);
  });
  
  // WebRTC signaling
  socket.on('signal', (data) => {
    console.log('Signal from', socket.id, 'to', data.to);
    
    // Forward the signal to the intended recipient
    if (data.to && io.sockets.sockets.get(data.to)) {
      io.to(data.to).emit('signal', {
        from: socket.id,
        signal: data.signal
      });
    }
  });
  
  // User disconnects
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    
    if (socket.roomName && rooms[socket.roomName]) {
      // Remove user from room
      delete rooms[socket.roomName].users[socket.id];
      
      // If room is empty, delete it
      if (Object.keys(rooms[socket.roomName].users).length === 0) {
        delete rooms[socket.roomName];
      } 
      // If host left, assign new host
      else if (rooms[socket.roomName].host === socket.id) {
        const newHostId = Object.keys(rooms[socket.roomName].users)[0];
        rooms[socket.roomName].host = newHostId;
        
        // Notify remaining users about the host change
        io.to(socket.roomName).emit('host-changed', newHostId);
      }
      
      // Notify remaining users about the disconnection
      io.to(socket.roomName).emit('user-left', {
        userId: socket.id,
        users: rooms[socket.roomName]?.users
      });
    }
    
    // Broadcast updated room list after user disconnection
    io.emit('rooms-list-updated', Object.keys(rooms));
  });
});

const PORT = process.env.PORT || 5500;
server.listen(PORT, () => {
  console.log(`Virtual LAN server running on port ${PORT}`);
});