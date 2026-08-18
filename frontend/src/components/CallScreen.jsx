export default function CallScreen({
  status,
  isRecording,
  isAiSpeaking,
  isThinking,
  transcript,
  errorMessage,
  startCall,
  beginRecording,
  stopRecording,
  endCall,
}) {
  const inCall = status === "in_call";
  const micDisabled = isAiSpeaking || isThinking || !inCall;

  return (
    <div className="call-screen">
      <div className="call-header">
        <h1>Health Screening Call</h1>
        <p className="subtitle">Talk to the intake assistant like you would on a real screening call.</p>
      </div>

      {status === "idle" && (
        <button className="btn btn-primary btn-large" onClick={startCall}>
          Start Call
        </button>
      )}

      {status === "connecting" && <p className="status-text">Connecting…</p>}

      {(inCall || status === "generating_report") && (
        <>
          <div className="transcript">
            {transcript.length === 0 && <p className="status-text">Listening for the greeting…</p>}
            {transcript.map((turn, i) => (
              <div key={i} className={`bubble ${turn.speaker}`}>
                <span className="bubble-label">{turn.speaker === "ai" ? "Assistant" : "You"}</span>
                <p>{turn.text}</p>
              </div>
            ))}
            {isThinking && (
              <div className="bubble ai thinking">
                <span className="bubble-label">Assistant</span>
                <p>…</p>
              </div>
            )}
          </div>

          {errorMessage && <p className="error-text">{errorMessage}</p>}

          {inCall && (
            <div className="call-controls">
              <button
                className={`btn mic-btn ${isRecording ? "recording" : ""}`}
                disabled={micDisabled && !isRecording}
                onClick={isRecording ? stopRecording : beginRecording}
              >
                {isRecording ? "⏹ Stop & Send" : isAiSpeaking ? "🔊 Assistant speaking…" : "🎙 Tap to Speak"}
              </button>
              <button className="btn btn-secondary" onClick={endCall}>
                End Call
              </button>
            </div>
          )}

          {status === "generating_report" && <p className="status-text">Generating your report…</p>}
        </>
      )}
    </div>
  );
}
