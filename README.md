# Health Screening Voice Agent

A web app where a user has a live voice conversation with an AI agent that conducts a basic
health-screening intake call, then generates a structured report once the call ends.

Built for the take-home technical assessment. English conversation, push-to-talk turn-taking
over WebSockets (per the spec's explicit allowance for this pattern).

## What's in the pipeline

- **STT:** OpenAI Whisper (`whisper-1`)
- **LLM:** OpenAI Chat Completions (`gpt-4o-mini` by default) with **function calling** to track
  intake state
- **TTS:** OpenAI TTS (`tts-1`)
- **Transport:** WebSocket (`ws`) — each user turn is a push-to-talk recording, sent as one
  message; the server streams back the AI's text + synthesized audio for that turn as soon as
  it's ready. Not "upload the whole call as one file at the end."

## Architecture

```
Browser (React)                    Backend (Node/Express + ws)
──────────────                     ────────────────────────────
MediaRecorder captures  ──audio──▶  Whisper STT
one push-to-talk turn               │
                                     ▼
                                  Conversation Manager
                                  (message history + patientRecord state)
                                     │
                                     ▼
                                  GPT-4o-mini + function calling
                                  (update_patient_record tool)
                                     │
                                     ▼
                                  OpenAI TTS
                        ◀──audio──   │
Audio element plays reply           │
                                     │
"End Call" ────────────────────────▶│
                                  Report synthesis call
                        ◀──report──  (structured JSON via tool_choice)
```

### Conversation state management

This is the part the assessment cares about most, so worth spelling out: the LLM doesn't just
free-associate across turns. Two things keep it on track:

1. **Full message history** is replayed to the model every turn (standard chat-completions
   statelessness), so it has the whole conversation as context.
2. **A structured `patientRecord` object** (name, chiefComplaint, durationDescription, severity,
   otherSymptoms, notes) lives on the backend session and is updated via a tool call
   (`update_patient_record`) *every time* the model learns something. This is what actually
   prevents "did I already ask this?" bugs — the system prompt tells the model to check what it
   already knows before asking, and because the extraction happens as a side effect of normal
   conversation (not a separate post-hoc pass), the model is reasoning over the same
   understanding it just used to decide what to ask next.

The `patientRecord` also feeds directly into report generation as ground truth, independent of
whatever the final free-text summary says.

### Failure handling

- **Silence / STT returns nothing:** handled *before* it ever reaches the LLM — a deterministic
  "sorry, could you repeat that?" reply, so a flaky Whisper result can't derail the conversation
  or burn an LLM call.
- **STT API call fails outright:** caught, the call continues with a friendly retry prompt
  instead of dropping the WebSocket connection.
- **TTS fails:** the AI's text reply still gets sent to the client and shown in the transcript;
  the call just doesn't have audio for that one turn instead of dying.
- **Any other backend error mid-turn:** caught at the WebSocket handler level, sent to the client
  as a non-fatal `error` message, connection stays open.
- **Short/incomplete call:** `generateReport` explicitly handles an empty transcript (report says
  so plainly, `dataCompleteness: "none"`) and also has a fallback path if the report-synthesis
  LLM call itself fails — it falls back to building the report directly from the structured
  `patientRecord` rather than crashing.

### Nice-to-haves implemented

- **Barge-in:** tapping "Speak" while the AI's audio is still playing immediately stops playback
  (see `stopAiAudio` in `useVoiceCall.js`).
- **Silence handling:** see Failure handling above.

### Nice-to-haves *not* implemented (given more time)

- Auto language detection / mid-call language switching (built for English only — Whisper's
  `language` param is hardcoded; removing that and asking the LLM to reply in whatever language
  it's given would get you most of the way there).
- True full-duplex/streaming audio (this uses push-to-talk turns, as the spec allows). A
  streaming version would use the OpenAI Realtime API or a streaming STT websocket
  (Deepgram/AssemblyAI) instead of discrete Whisper calls per turn, which would cut latency a lot.
- Persistent session storage (currently in-memory `Map` — fine for a demo, would move to
  Redis/Postgres for anything real).
- Client-side silence/VAD detection to auto-stop recording instead of manual tap-to-stop.

## Setup

### Prerequisites

- Node.js 18+
- An OpenAI API key with access to Whisper, Chat Completions, and TTS

### Backend

```bash
cd backend
npm install
cp .env.example .env
# edit .env and set OPENAI_API_KEY=sk-...
npm start
```

Runs on `http://localhost:8080`, WebSocket at `ws://localhost:8080/ws`.

### Frontend

```bash
cd frontend
npm install
cp .env.example .env   # only needed if backend isn't on localhost:8080
npm run dev
```

Runs on `http://localhost:5173`. Open it, click **Start Call**, allow microphone access, and talk.

### Using it

1. Click **Start Call** — the assistant greets you and asks the first question.
2. Click **Tap to Speak**, say your answer, click **Stop & Send**.
3. Repeat — the assistant adapts based on what you say and won't re-ask answered questions.
4. Click **End Call** at any point to get the structured report.

## Environment variables

**Backend** (`backend/.env`):

| Variable | Required | Default | Notes |
|---|---|---|---|
| `OPENAI_API_KEY` | Yes | — | |
| `PORT` | No | `8080` | |
| `LLM_MODEL` | No | `gpt-4o-mini` | swap for `gpt-4o` for higher quality |
| `TTS_VOICE` | No | `alloy` | any OpenAI TTS voice |

**Frontend** (`frontend/.env`):

| Variable | Required | Default |
|---|---|---|
| `VITE_WS_URL` | No | `ws://localhost:8080/ws` |

## Notes on browser support

Tested against Chrome's `MediaRecorder` with `audio/webm;codecs=opus`. Safari's MediaRecorder
support for webm/opus is inconsistent — if targeting Safari, you'd want to detect and fall back
to a supported mime type (e.g. mp4/aac) or transcode server-side.
