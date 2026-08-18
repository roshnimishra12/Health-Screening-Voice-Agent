import { useVoiceCall } from "./hooks/useVoiceCall.js";
import CallScreen from "./components/CallScreen.jsx";
import ReportView from "./components/ReportView.jsx";

export default function App() {
  const call = useVoiceCall();

  if (call.status === "ended" && call.report) {
    return (
      <div className="app-shell">
        <ReportView report={call.report} onRestart={() => window.location.reload()} />
      </div>
    );
  }

  return (
    <div className="app-shell">
      <CallScreen {...call} />
    </div>
  );
}
