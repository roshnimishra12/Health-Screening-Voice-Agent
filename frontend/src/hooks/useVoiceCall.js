import { useCallback, useRef, useState } from "react";

const WS_URL = import.meta.env.VITE_WS_URL || "ws://localhost:8080/ws";

// Turns a Blob into a base64 string (no data: prefix).
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export function useVoiceCall() {
  const [status, setStatus] = useState("idle"); // idle | connecting | in_call | ended
  const [isRecording, setIsRecording] = useState(false);
  const [isAiSpeaking, setIsAiSpeaking] = useState(false);
  const [isThinking, setIsThinking] = useState(false); // waiting on STT->LLM->TTS round trip
  const [transcript, setTranscript] = useState([]); // { speaker, text }
  const [patientRecord, setPatientRecord] = useState(null);
  const [report, setReport] = useState(null);
  const [errorMessage, setErrorMessage] = useState(null);

  const wsRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const audioElRef = useRef(null);

  const playAudio = useCallback((base64Mp3) => {
    if (!base64Mp3) return Promise.resolve();
    return new Promise((resolve) => {
      const audio = new Audio(`data:audio/mp3;base64,${base64Mp3}`);
      audioElRef.current = audio;
      setIsAiSpeaking(true);
      audio.onended = () => {
        setIsAiSpeaking(false);
        resolve();
      };
      audio.onerror = () => {
        setIsAiSpeaking(false);
        resolve();
      };
      audio.play().catch(() => {
        setIsAiSpeaking(false);
        resolve();
      });
    });
  }, []);

  const stopAiAudio = useCallback(() => {
    // Barge-in: let the user interrupt the AI mid-sentence.
    if (audioElRef.current) {
      audioElRef.current.pause();
      audioElRef.current = null;
    }
    setIsAiSpeaking(false);
  }, []);

  const startCall = useCallback(() => {
    setStatus("connecting");
    setErrorMessage(null);
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "start_call" }));
    };

    ws.onmessage = async (event) => {
      const msg = JSON.parse(event.data);

      switch (msg.type) {
        case "connected":
          setStatus("in_call");
          break;

        case "user_transcript":
          setTranscript((t) => [...t, { speaker: "user", text: msg.text }]);
          break;

        case "ai_speech":
          setIsThinking(false);
          setTranscript((t) => [...t, { speaker: "ai", text: msg.text }]);
          await playAudio(msg.audio);
          break;

        case "state_update":
          setPatientRecord(msg.state);
          break;

        case "call_ended":
          setStatus("generating_report");
          break;

        case "report":
          setReport(msg.report);
          setStatus("ended");
          break;

        case "error":
          setIsThinking(false);
          setErrorMessage(msg.message);
          break;

        default:
          break;
      }
    };

    ws.onerror = () => {
      setErrorMessage("Connection error — please check the backend is running and retry.");
    };

    ws.onclose = () => {
      if (status !== "ended") {
        // Unexpected drop mid-call.
      }
    };
  }, [playAudio, status]);

  const beginRecording = useCallback(async () => {
    stopAiAudio(); // barge-in: cut the AI off if it was still talking
    setErrorMessage(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      const recorder = new MediaRecorder(stream, { mimeType });
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        const blob = new Blob(chunksRef.current, { type: mimeType });
        const base64 = await blobToBase64(blob);
        setIsThinking(true);
        wsRef.current?.send(JSON.stringify({ type: "user_audio", audio: base64 }));
      };

      mediaRecorderRef.current = recorder;
      recorder.start();
      setIsRecording(true);
    } catch (err) {
      setErrorMessage("Couldn't access your microphone. Please check browser permissions.");
    }
  }, [stopAiAudio]);

  const stopRecording = useCallback(() => {
    mediaRecorderRef.current?.stop();
    setIsRecording(false);
  }, []);

  const endCall = useCallback(() => {
    if (isRecording) stopRecording();
    stopAiAudio();
    wsRef.current?.send(JSON.stringify({ type: "end_call" }));
  }, [isRecording, stopRecording, stopAiAudio]);

  return {
    status,
    isRecording,
    isAiSpeaking,
    isThinking,
    transcript,
    patientRecord,
    report,
    errorMessage,
    startCall,
    beginRecording,
    stopRecording,
    endCall,
  };
}
