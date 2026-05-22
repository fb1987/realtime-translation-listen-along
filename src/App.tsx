import { useEffect, useMemo, useRef, useState } from "react";

type Status =
  | "Idle"
  | "Connecting"
  | "Listening"
  | "Translating"
  | "Reconnecting"
  | "Error";

type SessionResponse = {
  client_secret: string;
  expires_at?: number | null;
  language_filter_mode?: "session_instructions" | "todo_language_detection_gate";
  target_language: string;
};

type Timings = {
  connectedMs?: number;
  firstAudioMs?: number;
  firstTranscriptMs?: number;
  lastEndOfUtteranceMs?: number;
  reconnectMs?: number;
};

type ConfigResponse = {
  authRequired: boolean;
};

const TRANSLATION_CALL_URL =
  "https://api.openai.com/v1/realtime/translations/calls";

const TARGET_LANGUAGES = [
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "pt", label: "Portuguese" },
  { code: "fr", label: "French" },
  { code: "ja", label: "Japanese" },
  { code: "ru", label: "Russian" },
  { code: "zh", label: "Chinese" },
  { code: "de", label: "German" },
  { code: "ko", label: "Korean" },
  { code: "hi", label: "Hindi" },
  { code: "id", label: "Indonesian" },
  { code: "vi", label: "Vietnamese" },
  { code: "it", label: "Italian" },
];

function nowMs() {
  return performance.now();
}

function formatMs(value?: number) {
  if (value === undefined) return "-";
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(2)} s`;
}

function readStoredSecret() {
  return localStorage.getItem("translation_app_secret") ?? "";
}

function readStoredTargetLanguage() {
  const stored = localStorage.getItem("translation_target_language");
  return TARGET_LANGUAGES.some((language) => language.code === stored)
    ? (stored ?? "en")
    : "en";
}

export default function App() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const microphoneRef = useRef<MediaStream | null>(null);
  const startedAtRef = useRef(0);
  const reconnectStartedAtRef = useRef<number | null>(null);
  const firstAudioSeenRef = useRef(false);
  const reconnectingRef = useRef(false);
  const stopRequestedRef = useRef(false);
  const captionDraftRef = useRef("");

  const [status, setStatus] = useState<Status>("Idle");
  const [error, setError] = useState("");
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [debug, setDebug] = useState(false);
  const [captionsEnabled, setCaptionsEnabled] = useState(false);
  const [targetLanguage, setTargetLanguage] = useState(readStoredTargetLanguage);
  const [captionDraft, setCaptionDraft] = useState("");
  const [captionLines, setCaptionLines] = useState<string[]>([]);
  const [timings, setTimings] = useState<Timings>({});
  const [events, setEvents] = useState<string[]>([]);
  const [authRequired, setAuthRequired] = useState(false);
  const [secret, setSecret] = useState(readStoredSecret);
  const [languageFilterMode, setLanguageFilterMode] = useState<string>("");

  const active = status !== "Idle" && status !== "Error";
  const targetLanguageLabel =
    TARGET_LANGUAGES.find((language) => language.code === targetLanguage)?.label ??
    "English";
  const visibleCaptions = [...captionLines, captionDraft].filter(Boolean);

  const statusTone = useMemo(() => {
    if (status === "Error") return "bad";
    if (status === "Translating") return "hot";
    if (status === "Listening") return "good";
    if (status === "Connecting" || status === "Reconnecting") return "busy";
    return "calm";
  }, [status]);

  useEffect(() => {
    let cancelled = false;
    fetch("/config")
      .then((response) => response.json() as Promise<ConfigResponse>)
      .then((config) => {
        if (!cancelled) setAuthRequired(config.authRequired);
      })
      .catch(() => {
        if (!cancelled) setAuthRequired(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = volume;
      audioRef.current.muted = muted;
    }
  }, [muted, volume]);

  function rememberSecret(value: string) {
    setSecret(value);
    if (value) {
      localStorage.setItem("translation_app_secret", value);
    } else {
      localStorage.removeItem("translation_app_secret");
    }
  }

  function rememberTargetLanguage(value: string) {
    setTargetLanguage(value);
    localStorage.setItem("translation_target_language", value);
  }

  function logEvent(message: string) {
    setEvents((current) => {
      const next = [`${new Date().toLocaleTimeString()} ${message}`, ...current];
      return next.slice(0, 18);
    });
  }

  function appendCaption(delta: string) {
    if (!delta) return;
    captionDraftRef.current += delta;
    setCaptionDraft(captionDraftRef.current.trimStart());
  }

  function finalizeCaption(transcript?: string) {
    const nextLine = (transcript || captionDraftRef.current).trim();
    captionDraftRef.current = "";
    setCaptionDraft("");
    if (!nextLine) return;

    setCaptionLines((current) => [...current, nextLine].slice(-3));
  }

  function markFirstAudio() {
    if (firstAudioSeenRef.current || !startedAtRef.current) return;
    firstAudioSeenRef.current = true;
    setTimings((current) => ({
      ...current,
      firstAudioMs: nowMs() - startedAtRef.current,
    }));
    setStatus("Translating");
    logEvent("first translated audio");
  }

  async function requestMicrophone() {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    });
    microphoneRef.current = stream;
    return stream;
  }

  async function createClientSecret() {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (authRequired || secret) {
      headers.Authorization = `Bearer ${secret}`;
    }

    const response = await fetch("/session", {
      method: "POST",
      headers,
      body: JSON.stringify({ targetLanguage }),
    });

    const text = await response.text();
    let payload: Partial<SessionResponse> & { error?: string } = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { error: text };
    }

    if (!response.ok) {
      throw new Error(payload.error || "Could not create translation session.");
    }

    if (!payload.client_secret) {
      throw new Error("Server did not return a translation client secret.");
    }

    setLanguageFilterMode(payload.language_filter_mode ?? "");
    return payload.client_secret;
  }

  async function openPeerConnection(stream: MediaStream, clientSecret: string) {
    const pc = new RTCPeerConnection();
    const eventsChannel = pc.createDataChannel("oai-events");

    peerRef.current = pc;
    dataChannelRef.current = eventsChannel;

    for (const track of stream.getAudioTracks()) {
      pc.addTrack(track, stream);
    }

    pc.ontrack = ({ streams }) => {
      const [remoteStream] = streams;
      if (!audioRef.current || !remoteStream) return;

      audioRef.current.srcObject = remoteStream;
      audioRef.current.play().catch(() => {
        logEvent("audio playback waiting for browser permission");
      });

      for (const track of remoteStream.getAudioTracks()) {
        track.onunmute = markFirstAudio;
      }
    };

    pc.onconnectionstatechange = () => {
      logEvent(`peer ${pc.connectionState}`);
      if (pc.connectionState === "connected") {
        setStatus("Listening");
        setTimings((current) => ({
          ...current,
          connectedMs: nowMs() - startedAtRef.current,
          reconnectMs:
            reconnectStartedAtRef.current === null
              ? current.reconnectMs
              : nowMs() - reconnectStartedAtRef.current,
        }));
        reconnectStartedAtRef.current = null;
        reconnectingRef.current = false;
      }

      if (
        ["failed", "disconnected"].includes(pc.connectionState) &&
        !stopRequestedRef.current &&
        !reconnectingRef.current
      ) {
        reconnect().catch((reconnectError) => {
          fail(reconnectError);
        });
      }
    };

    eventsChannel.onopen = () => logEvent("events channel open");
    eventsChannel.onclose = () => logEvent("events channel closed");
    eventsChannel.onerror = () => logEvent("events channel error");
    eventsChannel.onmessage = ({ data }) => {
      try {
        const event = JSON.parse(data);
        if (debug) logEvent(event.type ?? "event");

        if (event.type === "session.output_transcript.delta") {
          appendCaption(event.delta ?? "");
          setStatus("Translating");
          setTimings((current) => ({
            ...current,
            firstTranscriptMs:
              current.firstTranscriptMs ?? nowMs() - startedAtRef.current,
          }));
        }

        if (event.type === "session.output_transcript.done") {
          finalizeCaption(event.transcript);
        }

        if (
          event.type === "session.input_audio_buffer.speech_stopped" ||
          event.type === "session.output_audio.done" ||
          event.type === "session.output_transcript.done"
        ) {
          setTimings((current) => ({
            ...current,
            lastEndOfUtteranceMs: nowMs() - startedAtRef.current,
          }));
          if (pc.connectionState === "connected") setStatus("Listening");
        }

        if (event.type === "error" || event.type === "session.error") {
          throw new Error(event.error?.message ?? "Realtime Translation error.");
        }
      } catch (parseError) {
        if (parseError instanceof Error) {
          logEvent(parseError.message);
        }
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const sdpResponse = await fetch(TRANSLATION_CALL_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${clientSecret}`,
        "Content-Type": "application/sdp",
      },
      body: offer.sdp,
    });

    const answerSdp = await sdpResponse.text();
    if (!sdpResponse.ok) {
      throw new Error(answerSdp || "OpenAI did not accept the WebRTC offer.");
    }

    await pc.setRemoteDescription({
      type: "answer",
      sdp: answerSdp,
    });
  }

  async function start() {
    if (authRequired && !secret.trim()) {
      setError("Enter the private password first.");
      setStatus("Error");
      return;
    }

    stopRequestedRef.current = false;
    firstAudioSeenRef.current = false;
    startedAtRef.current = nowMs();
    reconnectStartedAtRef.current = null;
    setTimings({});
    setEvents([]);
    captionDraftRef.current = "";
    setCaptionDraft("");
    setCaptionLines([]);
    setError("");
    setStatus("Connecting");

    try {
      const stream = await requestMicrophone();
      const clientSecret = await createClientSecret();
      await openPeerConnection(stream, clientSecret);
    } catch (startError) {
      fail(startError);
    }
  }

  async function reconnect() {
    const stream = microphoneRef.current;
    if (!stream) return;

    reconnectingRef.current = true;
    reconnectStartedAtRef.current = nowMs();
    setStatus("Reconnecting");
    teardownPeerOnly();

    const clientSecret = await createClientSecret();
    await openPeerConnection(stream, clientSecret);
  }

  function teardownPeerOnly() {
    dataChannelRef.current?.close();
    dataChannelRef.current = null;

    peerRef.current?.getSenders().forEach((sender) => {
      try {
        peerRef.current?.removeTrack(sender);
      } catch {
        // The peer connection may already be closing.
      }
    });
    peerRef.current?.close();
    peerRef.current = null;

    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.srcObject = null;
    }
  }

  function stop() {
    stopRequestedRef.current = true;
    reconnectingRef.current = false;
    teardownPeerOnly();

    microphoneRef.current?.getTracks().forEach((track) => track.stop());
    microphoneRef.current = null;

    setStatus("Idle");
    setError("");
    logEvent("stopped");
  }

  function fail(rawError: unknown) {
    const message =
      rawError instanceof Error ? rawError.message : "Something went wrong.";
    stopRequestedRef.current = true;
    reconnectingRef.current = false;
    teardownPeerOnly();
    microphoneRef.current?.getTracks().forEach((track) => track.stop());
    microphoneRef.current = null;
    setError(message);
    setStatus("Error");
  }

  return (
    <main className="app-shell">
      <audio
        ref={audioRef}
        autoPlay
        playsInline
        onPlaying={markFirstAudio}
        aria-hidden="true"
      />

      <section className="translation-panel" aria-label="Live translation">
        <div className="top-row">
          <div>
            <p className="eyebrow">Chinese to {targetLanguageLabel}</p>
            <h1>Live Translation</h1>
          </div>
          <span className={`status-pill ${statusTone}`}>{status}</span>
        </div>

        {authRequired && (
          <label className="field">
            <span>Private password</span>
            <input
              type="password"
              value={secret}
              autoComplete="current-password"
              disabled={active}
              onChange={(event) => rememberSecret(event.target.value)}
            />
          </label>
        )}

        <div className="session-options" aria-label="Translation options">
          <label className="select-control">
            <span>Translate into</span>
            <select
              value={targetLanguage}
              disabled={active}
              onChange={(event) => rememberTargetLanguage(event.target.value)}
            >
              {TARGET_LANGUAGES.map((language) => (
                <option key={language.code} value={language.code}>
                  {language.label}
                </option>
              ))}
            </select>
          </label>

          <label className="toggle-control captions-toggle">
            <input
              type="checkbox"
              checked={captionsEnabled}
              onChange={(event) => setCaptionsEnabled(event.target.checked)}
            />
            <span>Captions</span>
          </label>
        </div>

        <button
          className={`start-button ${active ? "active" : ""}`}
          type="button"
          onClick={active ? stop : start}
        >
          {active ? "Stop Translation" : "Start Translation"}
        </button>

        <p className="status-line">
          {error ||
            (status === "Idle"
              ? "Idle"
              : status === "Connecting"
                ? "Connecting microphone and translation session"
                : status === "Reconnecting"
                  ? "Reconnecting translation audio"
                  : status === "Translating"
                    ? "Translating"
                    : "Listening")}
        </p>

        {captionsEnabled && (
          <div className="captions-panel" aria-live="polite">
            {visibleCaptions.length ? (
              visibleCaptions.map((line, index) => (
                <p
                  className={
                    index === visibleCaptions.length - 1
                      ? "caption-line active"
                      : "caption-line"
                  }
                  key={`${line}-${index}`}
                >
                  {line}
                </p>
              ))
            ) : (
              <p className="caption-placeholder">Captions will appear here</p>
            )}
          </div>
        )}

        <div className="controls" aria-label="Audio controls">
          <label className="range-control">
            <span>Volume</span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={volume}
              onChange={(event) => setVolume(Number(event.target.value))}
            />
          </label>

          <label className="toggle-control">
            <input
              type="checkbox"
              checked={muted}
              onChange={(event) => setMuted(event.target.checked)}
            />
            <span>Mute</span>
          </label>

          <label className="toggle-control">
            <input
              type="checkbox"
              checked={debug}
              onChange={(event) => setDebug(event.target.checked)}
            />
            <span>Debug</span>
          </label>
        </div>

        {debug && (
          <div className="debug-panel">
            <div className="debug-grid">
              <span>Connected</span>
              <strong>{formatMs(timings.connectedMs)}</strong>
              <span>First audio</span>
              <strong>{formatMs(timings.firstAudioMs)}</strong>
              <span>First transcript</span>
              <strong>{formatMs(timings.firstTranscriptMs)}</strong>
              <span>Last utterance marker</span>
              <strong>{formatMs(timings.lastEndOfUtteranceMs)}</strong>
              <span>Reconnect</span>
              <strong>{formatMs(timings.reconnectMs)}</strong>
            </div>
            {languageFilterMode && (
              <p className="debug-note">Filter: {languageFilterMode}</p>
            )}
            <ol className="event-list">
              {events.map((event) => (
                <li key={event}>{event}</li>
              ))}
            </ol>
          </div>
        )}
      </section>
    </main>
  );
}
