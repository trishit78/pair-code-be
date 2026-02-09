import { WebSocketServer, WebSocket } from "ws";
import http from "http";
import type { Room } from "../types/room.js";
import { broadcast } from "../utils/broadCast.js";
import { setupWSConnection } from "@y/websocket-server/utils";

const rooms: Room = {};

console.log("📦 socket.ts loaded");

// Ping interval for keepalive (30 seconds)
const PING_INTERVAL_MS = 30000;

export function setupWebSocket(server: http.Server) {
  // Use noServer mode for full control over upgrade handling
  const wss = new WebSocketServer({ noServer: true });

  console.log("🧩 WebSocketServer initialized (noServer mode)");

  // Handle HTTP upgrade requests manually
  server.on("upgrade", (request, socket, head) => {
    const reqUrl = new URL(request.url!, `http://${request.headers.host}`);

    // Only accept connections to /ws or /ws/ path
    // (y-websocket adds trailing slash when roomName is empty)
    const validPaths = ["/ws", "/ws/"];
    if (!validPaths.includes(reqUrl.pathname)) {
      console.log("❌ Rejected upgrade request to path:", reqUrl.pathname);
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  // Setup ping/pong keepalive to prevent idle disconnects
  const pingInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if ((ws as any).isAlive === false) {
        console.log("🔴 Terminating dead connection");
        return ws.terminate();
      }
      (ws as any).isAlive = false;
      ws.ping();
    });
  }, PING_INTERVAL_MS);

  wss.on("close", () => {
    clearInterval(pingInterval);
  });

  wss.on("connection", function connection(ws, request) {
    // Mark connection as alive
    (ws as any).isAlive = true;
    ws.on("pong", () => {
      (ws as any).isAlive = true;
    });

    const reqUrl = new URL(request.url!, `http://${request.headers.host}`);

    // Parse room info from query params
    const roomId = reqUrl.searchParams.get("room");
    const connectionType = reqUrl.searchParams.get("type") || "room";

    console.log(`🔗 New connection: room=${roomId}, type=${connectionType}`);

    if (!roomId) {
      console.log("❌ No room ID provided");
      ws.close(1008, "Room ID required");
      return;
    }

    // Route Yjs connections
    if (connectionType === "yjs") {
      console.log("🟢 Yjs connection detected for room:", roomId);
      const docName = `yjs-${roomId}`;
      
      // Add error handler for Yjs connections
      ws.on("error", (err) => {
        console.error("❌ Yjs WebSocket error:", err);
      });
      
      ws.on("close", (code, reason) => {
        console.log(`🔴 Yjs connection closed: code=${code}, reason=${reason?.toString()}`);
      });
      
      try {
        setupWSConnection(ws, request, { docName });
        console.log("✅ Yjs setupWSConnection completed for:", docName);
      } catch (err) {
        console.error("❌ Error in setupWSConnection:", err);
        ws.close(1011, "Internal server error");
      }
      return;
    }

    // Handle regular room connections
    console.log("🟢 Room connection for:", roomId);
    let currentRoomId: string | null = roomId;
    let currentUserName: string | null = null;

    ws.on("error", console.error);

    ws.on("message", function message(data) {
      console.log("📩 Raw message received:", data.toString());
      let parsedData;
      try {
        parsedData = JSON.parse(data.toString());
        console.log("📦 Parsed message:", parsedData);
      } catch (error) {
        console.log("❌ JSON parse error:", error);
        return;
      }

      if (parsedData.type === "JOIN_ROOM") {
        const { userName, roomId: msgRoomId } = parsedData;
        console.log(`👤 User "${userName}" is joining room "${msgRoomId}"`);

        // Use room from message or fall back to query param
        const targetRoom = msgRoomId || currentRoomId;
        if (!targetRoom) {
          ws.close(1008, "Room ID required");
          return;
        }

        currentRoomId = targetRoom;
        currentUserName = userName;

        if (!rooms[targetRoom]) {
          console.log("🧠 Current rooms object:", Object.keys(rooms));
          console.log(`🆕 Room "${targetRoom}" created`);
          rooms[targetRoom] = {
            clients: new Set(),
            code: "",
            question: null,
            users: new Map(),
          };
        }

        rooms[targetRoom].clients.add(ws);
        rooms[targetRoom].users.set(ws, userName);

        console.log(
          `👥 Room "${targetRoom}" clients count:`,
          rooms[targetRoom].clients.size
        );

        ws.send(
          JSON.stringify({
            type: "CODE_UPDATE",
            code: rooms[targetRoom].code,
          })
        );
        console.log(`📤 Sent CODE_UPDATE to "${userName}"`);

        ws.send(
          JSON.stringify({
            type: "USER_LIST",
            users: Array.from(rooms[targetRoom].users.values()),
          })
        );

        broadcast(
          targetRoom,
          {
            type: "USER_JOINED",
            userName: currentUserName,
          },
          rooms,
          ws
        );

        if (rooms[targetRoom].question) {
          ws.send(
            JSON.stringify({
              type: "QUESTION_UPDATE",
              question: rooms[targetRoom].question,
            })
          );
        }
      } else if (parsedData.type === "CODE_CHANGE") {
        const { codeChange } = parsedData;
        if (currentRoomId && rooms[currentRoomId]) {
          rooms[currentRoomId]!.code = codeChange;
          broadcast(
            currentRoomId,
            {
              type: "CODE_UPDATE",
              code: codeChange,
              userName: currentUserName,
            },
            rooms,
            ws
          );
        }
      } else if (parsedData.type === "LEAVE_ROOM" && currentRoomId) {
        leaveRoom(ws, currentRoomId, currentUserName);
        currentRoomId = null;
      } else if (parsedData.type === "QUESTION_CHANGE") {
        const { question } = parsedData;
        if (currentRoomId && rooms[currentRoomId]) {
          rooms[currentRoomId]!.question = question;
          broadcast(
            currentRoomId,
            {
              type: "QUESTION_UPDATE",
              question,
              userName: currentUserName,
            },
            rooms
          );
        }
      } else if (parsedData.type === "SOLUTION_REVIEW") {
        const { solution } = parsedData;
        if (currentRoomId && rooms[currentRoomId]) {
          broadcast(
            currentRoomId,
            {
              type: "SOLUTION_REVIEW",
              solution,
            },
            rooms
          );
        }
      }
    });

    ws.on("close", () => {
      if (currentRoomId) {
        leaveRoom(ws, currentRoomId, currentUserName);
      }
    });
  });
}

function leaveRoom(ws: WebSocket, roomId: string, userName: string | null) {
  if (!rooms[roomId]) return;

  rooms[roomId].clients.delete(ws);
  rooms[roomId].users.delete(ws);

  broadcast(
    roomId,
    {
      type: "USER_LIST",
      users: Array.from(rooms[roomId].users.values()),
    },
    rooms
  );

  broadcast(
    roomId,
    {
      type: "USER_LEFT",
      userName,
    },
    rooms,
    ws
  );

  if (rooms[roomId].clients.size === 0) {
    delete rooms[roomId];
  }
}