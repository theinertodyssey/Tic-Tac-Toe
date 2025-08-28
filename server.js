// server.js
const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // Adjust if you deploy behind proxy/CDN
  cors: { origin: false }
});

// serve client
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});

/** ====== In-memory room manager (simple & fast) ====== */
const rooms = new Map();
// Each room: {
//   code: "ABC123",
//   board: ['','','','','','','','',''],
//   currentPlayer: 'X',
//   gameActive: true|false,
//   players: { X: { id, name }, O: { id, name } },
//   createdAt: 1710000000
// }

const LINES = [
  [0,1,2],[3,4,5],[6,7,8],
  [0,3,6],[1,4,7],[2,5,8],
  [0,4,8],[2,4,6]
];

function createRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/1/0 to avoid confusion
  while (true) {
    let s = "";
    for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
    if (!rooms.has(s)) return s;
  }
}
function checkWin(board) {
  for (const [a,b,c] of LINES) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return { winner: board[a], pattern: [a,b,c] };
    }
  }
  return null;
}
function resetRoomState(room) {
  room.board = Array(9).fill("");
  room.currentPlayer = "X";
  room.gameActive = true;
}

io.on("connection", (socket) => {
  // Helper to get the room object for this socket
  const getRoom = () => {
    const code = socket.data?.roomCode;
    return code ? rooms.get(code) : null;
  };

  socket.on("createRoom", ({ name }) => {
    const code = createRoomCode();
    const playerName = String(name || "Player X").slice(0, 24);

    const room = {
      code,
      board: Array(9).fill(""),
      currentPlayer: "X",
      gameActive: false,
      players: {
        X: { id: socket.id, name: playerName },
        O: null
      },
      createdAt: Date.now()
    };
    rooms.set(code, room);

    socket.join(code);
    socket.data = { roomCode: code, symbol: "X", name: playerName };

    socket.emit("roomCreated", { code, yourSymbol: "X" });
  });

  socket.on("joinRoom", ({ code, name }) => {
    const roomCode = String(code || "").toUpperCase();
    const playerName = String(name || "Player O").slice(0, 24);
    const room = rooms.get(roomCode);

    if (!room) {
      socket.emit("roomError", { message: "Room not found." });
      return;
    }
    if (room.players.O) {
      socket.emit("roomError", { message: "Room is already full." });
      return;
    }

    room.players.O = { id: socket.id, name: playerName };
    resetRoomState(room);

    socket.join(roomCode);
    socket.data = { roomCode, symbol: "O", name: playerName };

    // Let both players know the match is ready
    io.to(roomCode).emit("gameStart", {
      code: roomCode,
      players: { X: room.players.X.name, O: room.players.O.name },
      currentPlayer: "X",
      yourId: socket.id // only meaningful for the joining client
    });
  });

  socket.on("playerMove", ({ index }) => {
    const room = getRoom();
    if (!room || !room.gameActive) return;

    const symbol = socket.data?.symbol;
    if (!symbol) return;
    if (room.currentPlayer !== symbol) return; // not your turn
    if (typeof index !== "number" || index < 0 || index > 8) return;
    if (room.board[index] !== "") return;

    room.board[index] = symbol;

    // Notify both clients about the move
    io.to(room.code).emit("moveMade", { index, symbol });

    // Check outcome
    const winInfo = checkWin(room.board);
    if (winInfo) {
      room.gameActive = false;
      io.to(room.code).emit("gameOver", {
        winnerSymbol: winInfo.winner,
        pattern: winInfo.pattern
      });
      return;
    }
    if (room.board.every(c => c !== "")) {
      room.gameActive = false;
      io.to(room.code).emit("gameOver", { draw: true });
      return;
    }

    // Next turn
    room.currentPlayer = room.currentPlayer === "X" ? "O" : "X";
    io.to(room.code).emit("turn", { currentPlayer: room.currentPlayer });
  });

  socket.on("restartGame", () => {
    const room = getRoom();
    if (!room) return;
    resetRoomState(room);
    io.to(room.code).emit("gameRestarted", { currentPlayer: "X" });
  });

  socket.on("leaveRoom", () => {
    const room = getRoom();
    if (!room) return;

    const symbol = socket.data?.symbol;
    if (symbol && room.players[symbol]?.id === socket.id) {
      room.players[symbol] = null;
    }
    socket.leave(room.code);
    socket.data = {};

    io.to(room.code).emit("opponentLeft");

    // Clean up empty rooms
    if (!room.players.X && !room.players.O) rooms.delete(room.code);
  });

  socket.on("disconnect", () => {
    const room = getRoom();
    if (!room) return;

    const symbol = socket.data?.symbol;
    if (symbol && room.players[symbol]?.id === socket.id) {
      room.players[symbol] = null;
    }
    io.to(room.code).emit("opponentLeft");

    if (!room.players.X && !room.players.O) rooms.delete(room.code);
  });
});
