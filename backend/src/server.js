import "dotenv/config";
import express from "express";
import cors from "cors";
import { WebSocketServer } from "ws";
import { createServer } from "http";
import { v4 as uuid } from "uuid";

import { createSession, getSession, deleteSession } from "./sessionStore.js";
import { startCall, handleUserTurn } from "./conversationManager.js";
import { transcribeAudio, synthesizeSpeech, generateReport } from "./services/openaiService.js";

const PORT = process.env.PORT || 8080;

if (!process.env.OPENAI_API_KEY) {
  console.warn(
    "\n⚠️  OPENAI_API_KEY is not set. Copy backend/.env.example to backend/.env and add your key.\n"
  );
}

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));

// Fallback REST endpoint to fetch a report by session id (handy for
// refreshing the report page without replaying the whole call).
app.get("/api/report/:sessionId", async (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "session not found" });
  try {
    const report = await generateReport(session.transcript, session.patientRecord);
    res.json({ report });
  } catch (err) {
    res.status(500).json({ error: "report generation failed" });
  }
});

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

wss.on("connection", (ws) => {
  const sessionId = uuid();
  const session = createSession(sessionId);
  console.log(`[WS] client connected -> session ${sessionId}`);

  send(ws, { type: "connected", sessionId });

  ws.on("message", async (raw, isBinary) => {
    if (isBinary) return; // we only speak JSON text frames in this protocol

    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return send(ws, { type: "error", message: "Malformed message." });
    }

    try {
      switch (msg.type) {
        case "start_call": {
          const aiText = await startCall(session);
          const audio = await synthesizeSpeech(aiText);
          send(ws, { type: "ai_speech", text: aiText, audio: audio.toString("base64") });
          send(ws, { type: "state_update", state: session.patientRecord });
          break;
        }

        case "user_audio": {
          if (session.ended) break;
          if (!msg.audio) {
            send(ws, { type: "error", message: "No audio received." });
            break;
          }
          const audioBuffer = Buffer.from(msg.audio, "base64");

          let userText = "";
          try {
            userText = await transcribeAudio(audioBuffer, "turn.webm");
          } catch {
            // STT failed outright (not just silence) — recover instead of
            // killing the call.
            send(ws, {
              type: "ai_speech",
              text: "Sorry, I had trouble hearing that. Could you try again?",
              audio: (await synthesizeSpeech("Sorry, I had trouble hearing that. Could you try again?")).toString(
                "base64"
              ),
            });
            break;
          }

          send(ws, { type: "user_transcript", text: userText || "(no speech detected)" });

          const aiText = await handleUserTurn(session, userText);

          let audioBase64 = null;
          try {
            const audio = await synthesizeSpeech(aiText);
            audioBase64 = audio.toString("base64");
          } catch {
            // TTS failed — still send the text so the call can continue,
            // frontend will just show text instead of playing audio this turn.
          }

          send(ws, { type: "ai_speech", text: aiText, audio: audioBase64 });
          send(ws, { type: "state_update", state: session.patientRecord });
          break;
        }

        case "end_call": {
          session.ended = true;
          send(ws, { type: "call_ended" });
          try {
            const report = await generateReport(session.transcript, session.patientRecord);
            send(ws, { type: "report", report });
          } catch (err) {
            console.error("[Report] fatal error:", err);
            send(ws, { type: "error", message: "Report generation failed." });
          }
          break;
        }

        default:
          send(ws, { type: "error", message: `Unknown message type: ${msg.type}` });
      }
    } catch (err) {
      console.error("[WS] handler error:", err);
      send(ws, {
        type: "error",
        message: "Something went wrong on our end — you can keep talking, or end the call.",
      });
    }
  });

  ws.on("close", () => {
    console.log(`[WS] client disconnected -> session ${sessionId}`);
    // Keep the session around briefly in case the client refetches the report;
    // in a real app you'd TTL/evict these. Fine to leave in-memory for a take-home.
    setTimeout(() => deleteSession(sessionId), 10 * 60 * 1000);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Backend listening on http://localhost:${PORT} (WS at /ws)`);
});
