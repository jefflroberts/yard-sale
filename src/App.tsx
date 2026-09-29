import { type InfiniteData, useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  Archive,
  Bot,
  Camera,
  Check,
  ChevronRight,
  CircleDollarSign,
  Copy,
  Download,
  ExternalLink,
  Gauge,
  History,
  ImageUp,
  LoaderCircle,
  ScanLine,
  Search,
  Settings,
  Square,
  Trash2,
  Video,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { activeEditionKey, withEditionSelection } from "./editions";
import { splitEvidence, type MarketEvidence } from "./market-evidence";
import type { AgentRunHistory, AnalysisResponse, DetectedItem, HistoryPage, ScanMode, Stats } from "./types";

const EMPTY_STATS: Stats = {
  framesProcessed: 0,
  itemsIdentified: 0,
  searchesPerformed: 0,
  modelCalls: 0,
  lastUpdated: null,
};
const DEFAULT_MAX_CONCURRENT_FRAMES = 5;
const MAX_CONCURRENT_FRAMES_SETTING = 100;
const FIND_CRITERIA_STORAGE_KEY = "yard-sale-find-criteria";
const SCAN_MODE_STORAGE_KEY = "yard-sale-scan-mode";
const FIND_CRITERIA_PRESETS = [
  { label: "Vintage tees", value: "Vintage band tees worth more than $40" },
  { label: "Modern electronics", value: "Electronics that are still modern enough to use" },
  { label: "Designer goods", value: "Authentic designer clothing, shoes, bags, and accessories with strong resale value" },
  { label: "Collectibles", value: "Vintage toys, trading cards, figurines, and collectibles worth more than $30" },
  { label: "Quality cookware", value: "High-quality cookware, cast iron, knives, and small kitchen appliances worth reselling" },
  { label: "Rare media", value: "Rare, collectible, or out-of-print books, records, CDs, and physical media" },
];

type View = "scan" | "history";
type Source = "camera" | "video" | "image";
type HistoryModeFilter = ScanMode | "all";

async function fetchStats(): Promise<Stats> {
  const response = await fetch("/api/stats");
  if (!response.ok) throw new Error("Could not load processing statistics.");
  return response.json();
}

async function fetchItems(
  search: string,
  mode: HistoryModeFilter,
  cursor: string | null,
  signal: AbortSignal,
): Promise<HistoryPage> {
  const params = new URLSearchParams({ q: search });
  if (mode !== "all") params.set("mode", mode);
  if (cursor) params.set("cursor", cursor);
  const response = await fetch(`/api/items?${params}`, { signal });
  if (!response.ok) throw new Error("Could not load saved finds.");
  return response.json();
}

function useHistory(search: string, enabled: boolean, mode: HistoryModeFilter = "all") {
  return useInfiniteQuery({
    queryKey: ["items", search, mode],
    queryFn: ({ pageParam, signal }) => fetchItems(search, mode, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled,
  });
}

async function fetchFrameItems(itemId: string): Promise<DetectedItem[]> {
  const response = await fetch(`/api/items/${encodeURIComponent(itemId)}`);
  if (!response.ok) throw new Error("Could not load this find.");
  return response.json();
}

async function fetchAgentRun(itemId: string): Promise<AgentRunHistory> {
  const response = await fetch(`/api/agent-runs/by-item/${encodeURIComponent(itemId)}`);
  const body = (await response.json()) as AgentRunHistory | { error?: string };
  if (!response.ok) throw new Error("error" in body && body.error ? body.error : "Could not load agent activity.");
  return body as AgentRunHistory;
}

async function deleteFindRequest(itemId: string): Promise<void> {
  const response = await fetch(`/api/items/${encodeURIComponent(itemId)}`, { method: "DELETE" });
  if (!response.ok) throw new Error("Could not delete this find.");
}

async function deleteAllFindsRequest(): Promise<void> {
  const response = await fetch("/api/items", { method: "DELETE" });
  if (!response.ok) throw new Error("Could not delete all finds.");
}

async function selectEditionRequest(itemId: string, selectedEditionKey: string | null): Promise<DetectedItem> {
  const response = await fetch(`/api/items/${encodeURIComponent(itemId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ selectedEditionKey }),
  });
  if (!response.ok) throw new Error("Could not save the edition.");
  return response.json();
}

export default function App({ children }: { children?: React.ReactNode }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const intervalRef = useRef<number | null>(null);
  const inFlightRef = useRef(0);
  const lastVideoTimeRef = useRef(-1);
  const streamItemTokenRef = useRef(0);
  const streamQueueRef = useRef<DetectedItem[]>([]);
  const streamTimerRef = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const scanIntervalSecondsRef = useRef(2);
  const [findCriteria, setFindCriteria] = useState(() =>
    window.localStorage.getItem(FIND_CRITERIA_STORAGE_KEY) ?? "",
  );
  const findCriteriaRef = useRef(findCriteria);
  const [scanMode, setScanMode] = useState<ScanMode>(() =>
    window.localStorage.getItem(SCAN_MODE_STORAGE_KEY) === "sell" ? "sell" : "buy",
  );
  const scanModeRef = useRef(scanMode);
  const [source, setSource] = useState<Source>("camera");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [inFlight, setInFlight] = useState(0);
  const [liveItems, setLiveItems] = useState<DetectedItem[]>([]);
  const [streamItemTokens, setStreamItemTokens] = useState<Record<string, number>>({});
  const [selectedItem, setSelectedItem] = useState<DetectedItem | null>(null);
  const [selectedFrameItems, setSelectedFrameItems] = useState<DetectedItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sourceLabel, setSourceLabel] = useState("Camera ready");
  const [cameraDevices, setCameraDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedCameraId, setSelectedCameraId] = useState("off");
  const [stillPreviewUrl, setStillPreviewUrl] = useState<string | null>(null);
  const [snapshotFlash, setSnapshotFlash] = useState(0);
  const [scanIntervalSeconds, setScanIntervalSeconds] = useState(2);
  const [maxConcurrentFrames, setMaxConcurrentFrames] = useState(() => {
    const saved = Number(window.localStorage.getItem("yard-sale-max-concurrent-frames"));
    return Number.isInteger(saved) && saved >= 1 && saved <= MAX_CONCURRENT_FRAMES_SETTING
      ? saved
      : DEFAULT_MAX_CONCURRENT_FRAMES;
  });
  const maxConcurrentFramesRef = useRef(maxConcurrentFrames);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historySearch, setHistorySearch] = useState("");
  const [historyMode, setHistoryMode] = useState<HistoryModeFilter>("all");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(historySearch.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [historySearch]);
  const [deletingItemId, setDeletingItemId] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useRouterState({ select: (state) => state.location });
  const findPath = location.pathname.split("/");
  const itemId = findPath[1] === "finds" && findPath[2] ? decodeURIComponent(findPath[2]) : null;
  const activityOpen = Boolean(itemId && findPath[3] === "activity");
  const view: View = location.pathname === "/history" || (itemId && location.search.from !== "scan")
    ? "history"
    : "scan";
  const { data: stats = EMPTY_STATS } = useQuery({ queryKey: ["stats"], queryFn: fetchStats });
  const history = useHistory(debouncedSearch, view === "history", historyMode);
  const savedFinds = useHistory("", settingsOpen);
  const historyItems = useMemo(() =>
    [...new Map(history.data?.pages.flatMap((page) => page.items).map((item) => [item.id, item]) ?? []).values()],
  [history.data]);
  const settingsItems = useMemo(() =>
    [...new Map(savedFinds.data?.pages.flatMap((page) => page.items).map((item) => [item.id, item]) ?? []).values()],
  [savedFinds.data]);
  const searchPending = historySearch.trim() !== debouncedSearch;
  const { data: routedFrameItems = [] } = useQuery({
    queryKey: ["frame-items", itemId],
    queryFn: () => fetchFrameItems(itemId!),
    enabled: Boolean(itemId),
  });

  const updateFindCriteria = (nextCriteria: string) => {
    findCriteriaRef.current = nextCriteria;
    setFindCriteria(nextCriteria);
    window.localStorage.setItem(FIND_CRITERIA_STORAGE_KEY, nextCriteria);
  };

  const updateScanMode = (nextMode: ScanMode) => {
    scanModeRef.current = nextMode;
    setScanMode(nextMode);
    window.localStorage.setItem(SCAN_MODE_STORAGE_KEY, nextMode);
  };

  const refreshHistory = useCallback(
    async () => queryClient.invalidateQueries({ queryKey: ["items"] }),
    [queryClient],
  );

  // Items live in several places (live feed, history pages, frame lists, the open detail); update them all.
  const applyItemUpdate = useCallback((updated: DetectedItem) => {
    const swap = (candidate: DetectedItem) => (candidate.id === updated.id ? updated : candidate);
    setSelectedItem((current) => (current ? swap(current) : current));
    setSelectedFrameItems((current) => current.map(swap));
    setLiveItems((current) => current.map(swap));
    queryClient.setQueriesData<DetectedItem[]>({ queryKey: ["frame-items"] }, (current) => current?.map(swap));
    queryClient.setQueriesData<InfiniteData<HistoryPage>>({ queryKey: ["items"] }, (current) =>
      current && { ...current, pages: current.pages.map((page) => ({ ...page, items: page.items.map(swap) })) },
    );
  }, [queryClient]);

  const changeEdition = useCallback(async (item: DetectedItem, selectedEditionKey: string | null) => {
    applyItemUpdate(withEditionSelection(item, selectedEditionKey));
    try {
      applyItemUpdate(await selectEditionRequest(item.id, selectedEditionKey));
    } catch (editionError) {
      applyItemUpdate(item);
      throw editionError;
    }
  }, [applyItemUpdate]);

  useEffect(() => {
    return () => {
      stopMedia();
      void audioContextRef.current?.close();
    };
  }, []);

  useEffect(() => {
    maxConcurrentFramesRef.current = maxConcurrentFrames;
    window.localStorage.setItem("yard-sale-max-concurrent-frames", String(maxConcurrentFrames));
  }, [maxConcurrentFrames]);

  const startItemStream = useCallback(() => {
    if (streamTimerRef.current !== null) return;

    const revealNext = () => {
      const nextItem = streamQueueRef.current.shift();
      if (!nextItem) {
        streamTimerRef.current = null;
        return;
      }

      const token = ++streamItemTokenRef.current;
      setStreamItemTokens((current) => ({ ...current, [nextItem.id]: token }));
      setLiveItems((current) => [nextItem, ...current.filter((item) => item.id !== nextItem.id)].slice(0, 100));
      streamTimerRef.current = window.setTimeout(revealNext, 500);
    };

    revealNext();
  }, []);

  const getAudioContext = useCallback(() => {
    if (!audioContextRef.current || audioContextRef.current.state === "closed") {
      audioContextRef.current = new window.AudioContext();
    }
    return audioContextRef.current;
  }, []);

  const unlockAudio = useCallback(() => {
    const context = getAudioContext();
    if (context.state === "suspended") void context.resume();
  }, [getAudioContext]);

  useEffect(() => {
    if (!itemId) {
      setSelectedItem(null);
      setSelectedFrameItems([]);
      return;
    }
    const availableItems = [...routedFrameItems, ...liveItems, ...historyItems];
    const routeItem = availableItems.find((item) => item.id === itemId);
    if (!routeItem) return;
    setSelectedItem(routeItem);
    setSelectedFrameItems(
      routedFrameItems.length > 0
        ? routedFrameItems
        : availableItems.filter((item) => item.thumbnailUrl === routeItem.thumbnailUrl),
    );
  }, [historyItems, itemId, liveItems, routedFrameItems]);

  const playFoundSound = useCallback(() => {
    const context = getAudioContext();
    if (context.state === "suspended") void context.resume();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(720, context.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(1_080, context.currentTime + 0.12);
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.22);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.24);
  }, [getAudioContext]);

  const playSnapshotFeedback = useCallback(() => {
    setSnapshotFlash((current) => current + 1);
    const context = getAudioContext();
    if (context.state === "suspended") void context.resume();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "square";
    oscillator.frequency.setValueAtTime(1_800, context.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(700, context.currentTime + 0.07);
    gain.gain.setValueAtTime(0.1, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.09);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.09);
  }, [getAudioContext]);

  const refreshCameras = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    setCameraDevices(devices.filter((device) => device.kind === "videoinput"));
  }, []);

  useEffect(() => {
    void refreshCameras();
    navigator.mediaDevices?.addEventListener("devicechange", refreshCameras);
    return () => navigator.mediaDevices?.removeEventListener("devicechange", refreshCameras);
  }, [refreshCameras]);

  const submitBlob = useCallback(
    async (activeSessionId: string, blob: Blob) => {
      if (inFlightRef.current >= maxConcurrentFramesRef.current) return;
      inFlightRef.current += 1;
      setInFlight(inFlightRef.current);
      try {
        const form = new FormData();
        form.set("sessionId", activeSessionId);
        form.set("capturedAt", new Date().toISOString());
        form.set("findCriteria", findCriteriaRef.current);
        form.set("mode", scanModeRef.current);
        form.set("image", blob, "frame.jpg");
        const response = await fetch("/api/analyze", { method: "POST", body: form });
        const body = (await response.json()) as AnalysisResponse | { error?: string };
        if (!response.ok) throw new Error("error" in body ? body.error : "Frame analysis failed");

        const result = body as AnalysisResponse;
        queryClient.setQueryData(["stats"], result.stats);
        if (result.items.length > 0) {
          streamQueueRef.current.push(...result.items);
          startItemStream();
          playFoundSound();
          void refreshHistory();
        }
        setError(null);
      } catch (frameError) {
        setError(frameError instanceof Error ? frameError.message : "Frame analysis failed");
      } finally {
        inFlightRef.current -= 1;
        setInFlight(inFlightRef.current);
      }
    },
    [playFoundSound, queryClient, refreshHistory, startItemStream],
  );

  const submitFrame = useCallback(
    async (activeSessionId: string, onCaptured?: () => void) => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || video.readyState < 2 || inFlightRef.current >= maxConcurrentFramesRef.current) return;
      if (video.currentTime === lastVideoTimeRef.current) return;
      lastVideoTimeRef.current = video.currentTime;

      const scale = Math.min(1, 960 / video.videoWidth);
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      const context = canvas.getContext("2d");
      if (!context) return;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      onCaptured?.();
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.76));
      if (!blob) return;
      await submitBlob(activeSessionId, blob);
    },
    [submitBlob],
  );

  const beginSession = useCallback(
    async (nextSource: Source, sourceName?: string) => {
      const id = crypto.randomUUID();
      const response = await fetch("/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, sourceType: nextSource, sourceName }),
      });
      if (!response.ok) throw new Error("Could not start a scan session.");
      setSessionId(id);
      setSource(nextSource);
      setLiveItems([]);
      return id;
    },
    [],
  );

  const openCamera = async (deviceId?: string): Promise<string> => {
    stopMedia();
    setStillPreviewUrl(null);
    const videoConstraint = deviceId
      ? { deviceId: { exact: deviceId } }
      : { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } };
    const stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraint, audio: false });
    streamRef.current = stream;
    if (!videoRef.current) throw new Error("Camera preview is unavailable.");
    videoRef.current.src = "";
    videoRef.current.srcObject = stream;
    videoRef.current.muted = true;
    await videoRef.current.play();
    const activeDeviceId = stream.getVideoTracks()[0]?.getSettings().deviceId ?? deviceId ?? "";
    setSelectedCameraId(activeDeviceId || "off");
    setSourceLabel(stream.getVideoTracks()[0]?.label || "Camera");
    await refreshCameras();
    return beginSession("camera");
  };

  const ensureCamera = async (): Promise<string> => {
    if (streamRef.current && source === "camera" && sessionId) return sessionId;
    return openCamera(selectedCameraId === "off" ? undefined : selectedCameraId);
  };

  const startLiveScan = (activeSessionId: string) => {
    setScanning(true);
    intervalRef.current = window.setInterval(
      () => void submitFrame(activeSessionId, playSnapshotFeedback),
      scanIntervalSecondsRef.current * 1_000,
    );
    window.setTimeout(() => void submitFrame(activeSessionId, playSnapshotFeedback), 350);
  };

  const changeScanInterval = (seconds: number) => {
    scanIntervalSecondsRef.current = seconds;
    setScanIntervalSeconds(seconds);
    if (!scanning || !sessionId) return;
    if (intervalRef.current !== null) window.clearInterval(intervalRef.current);
    intervalRef.current = window.setInterval(
      () => void submitFrame(sessionId, playSnapshotFeedback),
      seconds * 1_000,
    );
  };

  const toggleLiveScan = async () => {
    unlockAudio();
    try {
      if (scanning) {
        stopScan();
        return;
      }
      const id = await ensureCamera();
      startLiveScan(id);
    } catch (cameraError) {
      setError(cameraError instanceof Error ? cameraError.message : "Camera access failed");
    }
  };

  const takeSnapshot = async () => {
    unlockAudio();
    try {
      const id = await ensureCamera();
      await submitFrame(id, playSnapshotFeedback);
    } catch (cameraError) {
      setError(cameraError instanceof Error ? cameraError.message : "Camera snapshot failed");
    }
  };

  const selectCamera = async (deviceId: string) => {
    if (deviceId === "off") {
      stopMedia();
      setSelectedCameraId("off");
      setSessionId(null);
      setSourceLabel("Camera off");
      return;
    }
    const resumeScanning = scanning;
    try {
      const id = await openCamera(deviceId);
      if (resumeScanning) startLiveScan(id);
    } catch (cameraError) {
      setSelectedCameraId("off");
      setError(cameraError instanceof Error ? cameraError.message : "Camera access failed");
    }
  };

  const loadVideo = async (file: File) => {
    unlockAudio();
    try {
      stopMedia();
      setSelectedCameraId("off");
      setStillPreviewUrl(null);
      const url = URL.createObjectURL(file);
      objectUrlRef.current = url;
      if (!videoRef.current) return;
      videoRef.current.srcObject = null;
      videoRef.current.src = url;
      videoRef.current.muted = true;
      videoRef.current.loop = false;
      await videoRef.current.play();
      setSourceLabel(file.name);
      const id = await beginSession("video", file.name);
      startLiveScan(id);
    } catch (videoError) {
      setError(videoError instanceof Error ? videoError.message : "Video could not be loaded");
    }
  };

  const loadImage = async (file: File) => {
    unlockAudio();
    try {
      stopMedia();
      setSelectedCameraId("off");
      const url = URL.createObjectURL(file);
      objectUrlRef.current = url;
      setStillPreviewUrl(url);
      const image = new Image();
      image.src = url;
      await image.decode();
      const canvas = canvasRef.current;
      if (!canvas) throw new Error("Image canvas is unavailable.");
      const scale = Math.min(1, 960 / image.naturalWidth);
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Image canvas is unavailable.");
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      playSnapshotFeedback();
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
      if (!blob) throw new Error("The selected image could not be prepared.");
      setSourceLabel(file.name);
      const id = await beginSession("image", file.name);
      await submitBlob(id, blob);
    } catch (imageError) {
      setError(imageError instanceof Error ? imageError.message : "Image could not be loaded");
    }
  };

  const stopScan = () => {
    if (intervalRef.current !== null) window.clearInterval(intervalRef.current);
    intervalRef.current = null;
    setScanning(false);
  };

  function stopMedia() {
    if (intervalRef.current !== null) window.clearInterval(intervalRef.current);
    intervalRef.current = null;
    setScanning(false);
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.srcObject = null;
      videoRef.current.removeAttribute("src");
      videoRef.current.load();
    }
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = null;
    lastVideoTimeRef.current = -1;
  }

  const displayedItems = view === "scan" ? liveItems : historyItems;

  useEffect(() => {
    if (view !== "history") return;
    stopMedia();
    setSelectedCameraId("off");
    setSessionId(null);
    setStillPreviewUrl(null);
  }, [view]);

  const openItem = (selected: DetectedItem, sourceView: View) => {
    const sourceItems = sourceView === "scan" ? liveItems : historyItems;
    setSelectedItem(selected);
    setSelectedFrameItems(sourceItems.filter((candidate) => candidate.thumbnailUrl === selected.thumbnailUrl));
    void navigate({
      to: "/finds/$itemId",
      params: { itemId: selected.id },
      search: { from: sourceView },
      resetScroll: false,
    });
  };

  const deleteFind = async (item: DetectedItem) => {
    setDeletingItemId(item.id);
    try {
      await deleteFindRequest(item.id);
      setLiveItems((current) => current.filter((candidate) => candidate.id !== item.id));
      await refreshHistory();
      setError(null);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Could not delete this find.");
    } finally {
      setDeletingItemId(null);
    }
  };

  const deleteAllFinds = async () => {
    setDeletingItemId("all");
    try {
      await deleteAllFindsRequest();
      setLiveItems([]);
      await queryClient.resetQueries({ queryKey: ["items"] });
      setSettingsOpen(false);
      setError(null);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Could not delete all finds.");
    } finally {
      setDeletingItemId(null);
    }
  };

  return (
    <div className={`app-shell ${view === "scan" ? "scan-shell" : "history-shell"}`}>
      {view === "scan" ? (
        <main className="immersive-scan">
          <section className="camera-stage">
            <video ref={videoRef} playsInline onEnded={stopScan} />
            {stillPreviewUrl && <img className="still-preview" src={stillPreviewUrl} alt="Uploaded frame" />}
            {!sessionId && (
              <div className="camera-empty">
                <div className="reticle"><ScanLine size={44} /></div>
              </div>
            )}
            <div className="camera-shade" aria-hidden="true" />
            {snapshotFlash > 0 && <span key={snapshotFlash} className="snapshot-flash" aria-hidden="true" />}

            <header className="scan-topbar">
              <label className="camera-select-control">
                <Camera size={14} />
                <select
                  value={selectedCameraId}
                  onChange={(event) => void selectCamera(event.target.value)}
                  aria-label="Select camera"
                >
                  <option value="off">Camera off</option>
                  {cameraDevices.map((device, index) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.label || `Camera ${index + 1}`}
                    </option>
                  ))}
                </select>
              </label>
              <div className="mode-toggle" role="group" aria-label="Scan mode">
                {(["buy", "sell"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={scanMode === mode ? "active" : ""}
                    aria-pressed={scanMode === mode}
                    onClick={() => updateScanMode(mode)}
                  >
                    {mode === "buy" ? "Buy" : "Sell"}
                  </button>
                ))}
              </div>
              <div className={`live-state ${scanning ? "is-live" : ""}`} aria-live="polite">
                <span />
                {scanning ? "Live" : "Paused"}
              </div>
              <button className="settings-trigger" onClick={() => setSettingsOpen(true)} aria-label="Open settings">
                <Settings size={15} />
              </button>
            </header>

            <section className="stats-ribbon" aria-label="Live processing statistics">
              <div className="stat active-stat" title={`${inFlight} of ${maxConcurrentFrames} requests active`}>
                {inFlight > 0 ? <LoaderCircle className="spin" size={12} /> : <Gauge size={12} />}
                <strong>{inFlight}/{maxConcurrentFrames}</strong>
                <span>Active</span>
              </div>
              <Stat label="Frames" value={stats.framesProcessed} />
              <Stat label="Items" value={stats.itemsIdentified} />
              <Stat label="Searches" value={stats.searchesPerformed} />
              <Stat label="Calls" value={stats.modelCalls} />
            </section>

            {sessionId && <div className="source-caption">
              {source === "camera" ? <Camera size={13} /> : source === "image" ? <ImageUp size={13} /> : <Video size={13} />}
              <span>{sourceLabel}</span>
            </div>}

            <section className="live-find-stack" aria-label="Latest finds">
              {liveItems.map((item) => (
                <ItemCard
                  key={`${item.id}-${streamItemTokens[item.id] ?? "stable"}`}
                  item={item}
                  animate
                  overlay
                  onSelect={(selected) => openItem(selected, "scan")}
                />
              ))}
            </section>

            {error && (
              <div className="error-banner">
                <span>{error}</span>
                <button onClick={() => setError(null)} aria-label="Dismiss error"><X size={16} /></button>
              </div>
            )}
            <canvas ref={canvasRef} hidden />
          </section>
        </main>
      ) : (
        <main className="history-screen">
          <header className="history-heading">
            <div>
              <p className="eyebrow">All-time finds</p>
              <h1>History</h1>
            </div>
            <div className="history-actions">
              <button className="icon-button" onClick={() => void refreshHistory()} aria-label="Refresh history">
                <History size={20} />
              </button>
              <button className="icon-button" onClick={() => setSettingsOpen(true)} aria-label="Open settings">
                <Settings size={19} />
              </button>
            </div>
          </header>
          <section className="stats-ribbon history-stats" aria-label="Processing statistics">
            <Stat label="Frames" value={stats.framesProcessed} />
            <Stat label="Items" value={stats.itemsIdentified} />
            <Stat label="Searches" value={stats.searchesPerformed} />
            <Stat label="Calls" value={stats.modelCalls} />
          </section>
          <div className="history-search">
            <Search size={18} aria-hidden="true" />
            <input type="search" aria-label="Search all history" placeholder="Search all finds, brands, descriptions…"
              maxLength={500} value={historySearch} onChange={(event) => setHistorySearch(event.target.value)} />
            {historySearch && <button onClick={() => setHistorySearch("")} aria-label="Clear history search"><X size={18} /></button>}
          </div>
          <div className="history-mode-filter criteria-presets" role="group" aria-label="Filter by scan mode">
            {([["all", "All"], ["buy", "Buy finds"], ["sell", "My items"]] as const).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                className={historyMode === mode ? "active" : ""}
                aria-pressed={historyMode === mode}
                onClick={() => setHistoryMode(mode)}
              >
                {label}
              </button>
            ))}
          </div>
          {error && (
            <div className="error-banner history-error">
              <span>{error}</span>
              <button onClick={() => setError(null)} aria-label="Dismiss error"><X size={16} /></button>
            </div>
          )}
          <section className="finds-section" aria-busy={history.isFetching || searchPending}>
            <HistoryLoading query={history} searchPending={searchPending} />
            <div className="item-feed">
              {displayedItems.map((item) => (
                <ItemCard key={`${item.id}-history`} item={item} showCapturedAt onSelect={(selected) => openItem(selected, "history")} />
              ))}
              {displayedItems.length === 0 && !history.isPending && !history.isError && !searchPending && (
                <div className="empty-feed">
                  <CircleDollarSign size={36} />
                  <p>{debouncedSearch ? "No finds match your search." : "No saved finds yet."}</p>
                </div>
              )}
            </div>
            <HistoryLoadMore query={history} disabled={searchPending} />
          </section>
        </main>
      )}

      <nav className={`bottom-nav ${view === "scan" ? "scan-nav" : ""}`} aria-label="Primary navigation">
        <Link to="/scan" className={view === "scan" ? "active" : ""}>
          <ScanLine /> <span>Scan</span>
        </Link>
        {view === "scan" && <>
          <button
            className={`dock-action ${scanning ? "is-active" : ""}`}
            onClick={() => void toggleLiveScan()}
            aria-label={scanning ? "Stop live scanning" : "Start live scanning"}
          >
            {scanning ? <Square size={18} fill="currentColor" /> : <ScanLine size={20} />}
            <span>{scanning ? "Stop" : "Live"}</span>
          </button>
          <button className="dock-action snapshot-action" onClick={() => void takeSnapshot()} aria-label="Take snapshot">
            <Camera size={22} />
            <span>Snap</span>
          </button>
          <label className="dock-action dock-upload" aria-label="Upload a photo or video">
            <ImageUp size={20} />
            <span>Upload</span>
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,image/*,video/mp4,video/quicktime,video/*"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file?.type.startsWith("image/")) void loadImage(file);
                else if (file) void loadVideo(file);
                event.currentTarget.value = "";
              }}
            />
          </label>
        </>}
        <Link to="/history" className={view === "history" ? "active" : ""} onClick={() => void refreshHistory()}>
          <Archive /> <span>History</span>
        </Link>
      </nav>

      {settingsOpen && (
        <div className="settings-backdrop" onMouseDown={() => setSettingsOpen(false)}>
          <section
            className="settings-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <p className="eyebrow">Saved inventory</p>
                <h2 id="settings-title">Settings</h2>
              </div>
              <button onClick={() => setSettingsOpen(false)} aria-label="Close settings"><X size={18} /></button>
            </header>
            <div className="settings-find-list">
              <div className="settings-text-field">
                <label htmlFor="find-criteria">Find criteria</label>
                <textarea
                  id="find-criteria"
                  rows={3}
                  maxLength={1000}
                  value={findCriteria}
                  placeholder="Vintage band tees worth more than $40"
                  onChange={(event) => updateFindCriteria(event.target.value)}
                />
                <div className="criteria-presets" aria-label="Quick find criteria">
                  {FIND_CRITERIA_PRESETS.map((preset) => (
                    <button
                      key={preset.label}
                      type="button"
                      className={findCriteria === preset.value ? "active" : ""}
                      onClick={() => updateFindCriteria(preset.value)}
                    >
                      {preset.label}
                    </button>
                  ))}
                  {findCriteria && <button type="button" onClick={() => updateFindCriteria("")}>Clear</button>}
                </div>
              </div>
              <div className="settings-range">
                <label htmlFor="concurrent-processing">
                  <span>Concurrent processing</span>
                  <strong>{maxConcurrentFrames}</strong>
                </label>
                <input
                  id="concurrent-processing"
                  type="range"
                  min="1"
                  max={MAX_CONCURRENT_FRAMES_SETTING}
                  step="1"
                  value={maxConcurrentFrames}
                  onChange={(event) => setMaxConcurrentFrames(Number(event.target.value))}
                />
                <div><span>1</span><span>{MAX_CONCURRENT_FRAMES_SETTING}</span></div>
              </div>
              <div className="settings-range">
                <label htmlFor="scan-frequency">
                  <span>Live scan frequency</span>
                  <strong>{scanIntervalSeconds}s</strong>
                </label>
                <input
                  id="scan-frequency"
                  type="range"
                  min="1"
                  max="30"
                  step="1"
                  value={scanIntervalSeconds}
                  onChange={(event) => changeScanInterval(Number(event.target.value))}
                />
                <div><span>1s</span><span>30s</span></div>
              </div>
              <HistoryLoading query={savedFinds} />
              {settingsItems.map((item) => (
                <div className="settings-find" key={item.id}>
                  <img src={item.thumbnailUrl} alt="" />
                  <div>
                    <strong>{item.name}</strong>
                    <span>{formatRange(item)}</span>
                  </div>
                  <button
                    onClick={() => void deleteFind(item)}
                    disabled={deletingItemId !== null}
                    aria-label={`Delete ${item.name}`}
                  >
                    {deletingItemId === item.id ? <LoaderCircle className="spin" size={17} /> : <Trash2 size={17} />}
                  </button>
                </div>
              ))}
              {settingsItems.length === 0 && !savedFinds.isPending && !savedFinds.isError && <p className="settings-empty">No saved finds.</p>}
              <HistoryLoadMore query={savedFinds} />
            </div>
            <footer>
              <button
                className="delete-all-button"
                onClick={() => void deleteAllFinds()}
                disabled={settingsItems.length === 0 || deletingItemId !== null}
              >
                {deletingItemId === "all" ? <LoaderCircle className="spin" size={17} /> : <Trash2 size={17} />}
                Delete all finds
              </button>
              <span>Processing stats are kept.</span>
            </footer>
          </section>
        </div>
      )}

      {selectedItem && (
        <ItemDetail
          item={selectedItem}
          onChangeEdition={(key) => changeEdition(selectedItem, key)}
          frameItems={selectedFrameItems.length > 0 ? selectedFrameItems : [selectedItem]}
          onSelect={(nextItem) => {
            setSelectedItem(nextItem);
            void navigate(
              activityOpen
                ? {
                    to: "/finds/$itemId/activity",
                    params: { itemId: nextItem.id },
                    search: { from: view },
                    replace: true,
                    resetScroll: false,
                  }
                : {
                    to: "/finds/$itemId",
                    params: { itemId: nextItem.id },
                    search: { from: view },
                    replace: true,
                    resetScroll: false,
                  },
            );
          }}
          activityOpen={activityOpen}
          onToggleActivity={() => {
            void navigate(
              activityOpen
                ? { to: "/finds/$itemId", params: { itemId: selectedItem.id }, search: { from: view }, resetScroll: false }
                : { to: "/finds/$itemId/activity", params: { itemId: selectedItem.id }, search: { from: view }, resetScroll: false },
            );
          }}
          onClose={() => {
            void navigate({ to: view === "scan" ? "/scan" : "/history", resetScroll: false });
          }}
        />
      )}
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat">
      <strong>{value.toLocaleString()}</strong>
      <span>{label}</span>
    </div>
  );
}

function HistoryLoading({ query, searchPending = false }: { query: ReturnType<typeof useHistory>; searchPending?: boolean }) {
  if (query.isError) return (
    <div className="history-status" role="alert">
      <span>{query.error.message}</span>
      <button className="history-load-more" onClick={() => void (query.isFetchNextPageError ? query.fetchNextPage() : query.refetch())} disabled={query.isFetching}>Retry</button>
    </div>
  );
  if (query.isFetching || searchPending) return <p className="history-status" role="status">{searchPending ? "Searching…" : "Loading finds…"}</p>;
  return null;
}

function HistoryLoadMore({ query, disabled = false }: { query: ReturnType<typeof useHistory>; disabled?: boolean }) {
  if (!query.hasNextPage) return null;
  return <button className="history-load-more" disabled={disabled || query.isFetching} onClick={() => void query.fetchNextPage()}>
    {query.isFetchingNextPage ? "Loading…" : "Load more finds"}
  </button>;
}

function CapturedTime({ timestamp }: { timestamp?: string | null }) {
  if (!timestamp || Number.isNaN(Date.parse(timestamp))) return null;
  const date = new Date(timestamp);
  return <time className="captured-time" dateTime={date.toISOString()}>
    Snapped {date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
  </time>;
}

function ItemCard({
  item,
  animate,
  overlay,
  showCapturedAt,
  onSelect,
}: {
  item: DetectedItem;
  animate?: boolean;
  overlay?: boolean;
  showCapturedAt?: boolean;
  onSelect: (item: DetectedItem) => void;
}) {
  return (
    <button
      className={`item-card${animate ? " stream-in" : ""}${overlay ? " overlay-card" : ""}`}
      onClick={() => onSelect(item)}
    >
      <div className="thumbnail-wrap">
        <ItemThumbnail item={item} />
        <span className="confidence">{Math.round(item.confidence * 100)}%</span>
      </div>
      <div className="item-copy">
        <div className="item-meta">
          <span>{item.category}</span>
          {item.mode === "sell" && <span className="sell-badge">Selling</span>}
          {item.editions.length > 1 && <span className="edition-badge">{item.editions.length} editions</span>}
          {item.duplicate && <span className="repeat-badge">Seen {item.seenCount}×</span>}
          {!showCapturedAt && <RelativeTime timestamp={item.firstSeenAt} />}
        </div>
        {showCapturedAt && <CapturedTime timestamp={item.lastSeenAt} />}
        <h3>{item.name}</h3>
        <p>{item.valueSummary}</p>
        {item.mode === "sell" ? (
          <div className="price-comparison card-prices">
            <div className="price-box resale-price">
              <span>Marketplace</span>
              <strong>{optionalMoney(item.listPriceCents, item.currency)}</strong>
            </div>
            <div className="price-box retail-price">
              <span>Yard sale</span>
              <strong>{optionalMoney(item.yardSalePriceCents, item.currency)}</strong>
            </div>
          </div>
        ) : (
          <div className="price-comparison card-prices">
            <div className="price-box resale-price">
              <span>Resale</span>
              <strong>{formatRange(item)}</strong>
            </div>
            <div className="price-box retail-price">
              <span>Retail</span>
              <strong>{optionalMoney(item.retailPriceCents, item.currency)}</strong>
            </div>
          </div>
        )}
        {item.observedPriceCents !== null && <span className="tag-price">Tag {money(item.observedPriceCents, item.currency)}</span>}
      </div>
      <ChevronRight className="card-chevron" size={20} />
    </button>
  );
}

function RelativeTime({ timestamp }: { timestamp: string }) {
  const [now, setNow] = useState(Date.now());
  const foundAt = Date.parse(timestamp);
  const ageMs = Math.max(0, now - foundAt);

  useEffect(() => {
    const refreshMs = ageMs < 60_000 ? 1_000 : ageMs < 3_600_000 ? 60_000 : 3_600_000;
    const timer = window.setTimeout(() => setNow(Date.now()), refreshMs);
    return () => window.clearTimeout(timer);
  }, [ageMs]);

  return (
    <time className="found-time" dateTime={timestamp} title={new Date(foundAt).toLocaleString()}>
      {formatRelativeTime(ageMs)}
    </time>
  );
}

function formatRelativeTime(ageMs: number) {
  const seconds = Math.floor(ageMs / 1_000);
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"} ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function ItemDetail({
  item,
  frameItems,
  activityOpen,
  onToggleActivity,
  onSelect,
  onClose,
  onChangeEdition,
}: {
  item: DetectedItem;
  frameItems: DetectedItem[];
  activityOpen: boolean;
  onToggleActivity: () => void;
  onSelect: (item: DetectedItem) => void;
  onClose: () => void;
  onChangeEdition: (selectedEditionKey: string | null) => Promise<void>;
}) {
  const [hoveredItemId, setHoveredItemId] = useState<string | null>(null);
  const modalRef = useRef<HTMLElement>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const downloadImage = async () => {
    if (!modalRef.current || downloading) return;
    const modal = modalRef.current;
    setDownloading(true);
    setDownloadError(null);
    try {
      const { downloadModalImage } = await import("./download-modal");
      await downloadModalImage(modal, `${item.name}${activityOpen ? "-activity" : ""}`);
    } catch {
      setDownloadError("Could not download the image. Check your connection and try again.");
    } finally {
      setDownloading(false);
    }
  };
  const frameListRef = useRef<HTMLDivElement>(null);
  const frameItemRefs = useRef(new Map<string, HTMLButtonElement>());
  const highlightedItemId = hoveredItemId ?? item.id;
  const evidence = splitEvidence(item);
  const [showEarlierSources, setShowEarlierSources] = useState(false);

  useEffect(() => {
    if (!hoveredItemId) return;
    const list = frameListRef.current;
    const matchedItem = frameItemRefs.current.get(hoveredItemId);
    if (!list || !matchedItem) return;

    const itemLeft = matchedItem.offsetLeft;
    const itemRight = itemLeft + matchedItem.offsetWidth;
    const visibleLeft = list.scrollLeft;
    const visibleRight = visibleLeft + list.clientWidth;
    if (itemLeft >= visibleLeft && itemRight <= visibleRight) return;

    const centeredLeft = matchedItem.offsetLeft - (list.clientWidth - matchedItem.offsetWidth) / 2;
    list.scrollTo({ left: centeredLeft, behavior: "instant" });
  }, [hoveredItemId]);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <article ref={modalRef} className="detail-sheet" onMouseDown={(event) => event.stopPropagation()}>
        <button className="download-image-button" data-export-exclude onClick={() => void downloadImage()} disabled={downloading} aria-label={downloading ? "Downloading image" : "Download modal as image"}>
          {downloading ? <LoaderCircle className="spin" size={18} /> : <Download size={18} />}
          {downloading ? "Preparing…" : "Download image"}
        </button>
        <button className="close-button" data-export-exclude onClick={onClose} aria-label="Close"><X /></button>
        <div className="detail-scroll">
          <div className="detail-visual">
            <AnnotatedImage
              key={item.thumbnailUrl}
              items={frameItems}
              activeItemId={highlightedItemId}
              onHoverItem={setHoveredItemId}
            />
          </div>
          <div className="detail-content">
          {downloadError && <p className="download-image-error" data-export-exclude role="alert">{downloadError}</p>}
          <p className="eyebrow">{frameItems.length} item{frameItems.length === 1 ? "" : "s"} found in this frame</p>
          <div ref={frameListRef} className="frame-find-list">
            {frameItems.map((frameItem) => (
              <button
                key={frameItem.id}
                ref={(element) => {
                  if (element) frameItemRefs.current.set(frameItem.id, element);
                  else frameItemRefs.current.delete(frameItem.id);
                }}
                className={frameItem.id === highlightedItemId ? "active" : ""}
                onClick={() => onSelect(frameItem)}
                onMouseEnter={() => setHoveredItemId(frameItem.id)}
                onMouseLeave={() => setHoveredItemId(null)}
              >
                <span>{frameItem.category}</span>
                <strong>{frameItem.name}</strong>
                <b>{frameItem.mode === "sell" ? optionalMoney(frameItem.listPriceCents, frameItem.currency) : formatRange(frameItem)}</b>
              </button>
            ))}
          </div>
          <button className="agent-activity-toggle" data-export-exclude onClick={onToggleActivity}>
            <Bot size={17} /> {activityOpen ? "Back to find" : "Agent activity"}
          </button>
          {activityOpen ? (
            <AgentActivity itemId={item.id} />
          ) : (
            <>
              <p className="eyebrow">{item.category} · {Math.round(item.confidence * 100)}% confidence</p>
              <h2>{item.name}</h2>
              <p className="detail-description">{item.description}</p>
              {item.editions.length > 0 && <EditionPicker key={item.id} item={item} onChange={onChangeEdition} />}
              {item.mode === "sell" && <SellerPricing item={item} />}
              <div className="detail-values">
                <div className="price-comparison">
                  <div className="price-box resale-price">
                    <span>Estimated resale</span>
                    <strong>{formatRange(item)}</strong>
                  </div>
                  <div className="price-box retail-price">
                    <span>Estimated retail</span>
                    <strong>{item.retailPriceCents === null ? "—" : money(item.retailPriceCents, item.currency)}</strong>
                  </div>
                </div>
              </div>
              <section className="comparables">
                <h3>Where these prices come from</h3>
                {item.valueSummary && <p className="comparables-summary">{item.valueSummary}</p>}
                {evidence.latest.map((entry, index) => <EvidenceRow key={`latest-${entry.title}-${index}`} entry={entry} />)}
                {evidence.earlier.length > 0 && (
                  <button type="button" className="earlier-sources-toggle" data-export-exclude onClick={() => setShowEarlierSources((open) => !open)}>
                    {showEarlierSources ? "Hide" : "Show"} {evidence.earlier.length} source{evidence.earlier.length === 1 ? "" : "s"} from earlier scans
                  </button>
                )}
                {showEarlierSources && evidence.earlier.map((entry, index) => <EvidenceRow key={`earlier-${entry.title}-${index}`} entry={entry} />)}
              </section>
              <a
                className="lens-search-link"
                data-export-exclude
                href={`https://lens.google.com/uploadbyurl?url=${encodeURIComponent(new URL(item.thumbnailUrl, window.location.origin).href)}`}
                target="_blank"
                rel="noreferrer"
              >
                <Search size={17} /> Search full frame with Google Lens <ExternalLink size={15} />
              </a>
              <dl className="facts">
                <div><dt>Brand</dt><dd>{item.brand ?? "Unknown"}</dd></div>
                <div><dt>Model</dt><dd>{item.model ?? "Unknown"}</dd></div>
                <div><dt>Condition</dt><dd>{item.condition}</dd></div>
                <div><dt>Seen</dt><dd>{item.seenCount} time{item.seenCount === 1 ? "" : "s"}</dd></div>
              </dl>
            </>
          )}
          </div>
        </div>
      </article>
    </div>
  );
}

function AgentActivity({ itemId }: { itemId: string }) {
  const { data, error, isPending } = useQuery({
    queryKey: ["agent-run", itemId],
    queryFn: () => fetchAgentRun(itemId),
    retry: false,
  });

  if (isPending) {
    return <div className="agent-activity-state"><LoaderCircle className="spin" /> Loading activity</div>;
  }
  if (error || !data) {
    return <div className="agent-activity-state error">{error instanceof Error ? error.message : "Agent activity unavailable."}</div>;
  }

  return (
    <section className="agent-activity">
      <header>
        <div>
          <span>{data.model}</span>
          <strong>{(data.latencyMs / 1_000).toFixed(1)}s</strong>
        </div>
        <div>
          <span>Calls</span>
          <strong>{data.modelCalls}</strong>
        </div>
        <div>
          <span>Searches</span>
          <strong>{data.searchesPerformed}</strong>
        </div>
        <div>
          <span>Items</span>
          <strong>{data.itemCount}</strong>
        </div>
      </header>

      <AuditBlock title="Agent instructions" value={data.instructions} open />
      <AuditBlock title="Input" value={data.input} open />

      <div className="agent-timeline">
        {data.events.map((event) => (
          <article key={`${event.sequence}-${event.type}`}>
            <span className="timeline-index">{event.sequence + 1}</span>
            <div>
              <h4>{event.title}</h4>
              <pre>{prettyAuditValue(event.data)}</pre>
            </div>
          </article>
        ))}
        {data.events.length === 0 && <p>No agent events were recorded.</p>}
      </div>

      <AuditBlock title={`Raw model responses · ${data.rawResponses.length}`} value={data.rawResponses} />
      <AuditBlock title="Final structured output" value={data.output} />
      <AuditBlock title="Usage" value={data.usage} />
    </section>
  );
}

function AuditBlock({ title, value, open = false }: { title: string; value: unknown; open?: boolean }) {
  return (
    <details className="audit-block" open={open}>
      <summary>{title}</summary>
      <pre>{prettyAuditValue(value)}</pre>
    </details>
  );
}

function prettyAuditValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function ItemThumbnail({ item }: { item: DetectedItem }) {
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);
  const box = item.boundingBox;
  const crop = box && imageSize ? paddedCrop(box, imageSize) : null;

  return (
    <>
      <img
        className={crop ? "thumbnail-source is-cropped" : "thumbnail-source"}
        src={item.thumbnailUrl}
        alt=""
        loading="lazy"
        onLoad={(event) => {
          const image = event.currentTarget;
          setImageSize({ width: image.naturalWidth, height: image.naturalHeight });
        }}
      />
      {crop && imageSize && (
        <svg className="cropped-thumbnail" viewBox={`${crop.x} ${crop.y} ${crop.width} ${crop.height}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
          <image href={item.thumbnailUrl} width={imageSize.width} height={imageSize.height} />
        </svg>
      )}
    </>
  );
}

function paddedCrop(
  box: NonNullable<DetectedItem["boundingBox"]>,
  imageSize: { width: number; height: number },
) {
  const x = (box.xMin / 1000) * imageSize.width;
  const y = (box.yMin / 1000) * imageSize.height;
  const width = ((box.xMax - box.xMin) / 1000) * imageSize.width;
  const height = ((box.yMax - box.yMin) / 1000) * imageSize.height;
  const paddingX = Math.max(width * 0.18, imageSize.width * 0.02);
  const paddingY = Math.max(height * 0.18, imageSize.height * 0.02);
  const cropX = Math.max(0, x - paddingX);
  const cropY = Math.max(0, y - paddingY);
  return {
    x: cropX,
    y: cropY,
    width: Math.min(imageSize.width - cropX, width + paddingX * 2),
    height: Math.min(imageSize.height - cropY, height + paddingY * 2),
  };
}

function AnnotatedImage({
  items,
  activeItemId,
  onHoverItem,
}: {
  items: DetectedItem[];
  activeItemId: string;
  onHoverItem: (itemId: string | null) => void;
}) {
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);
  const imageUrl = items[0]?.thumbnailUrl;

  return (
    <div className="annotated-image">
      <img
        src={imageUrl}
        alt=""
        onLoad={(event) => {
          const image = event.currentTarget;
          setImageSize({ width: image.naturalWidth, height: image.naturalHeight });
        }}
      />
      {imageSize && (
        <svg
          className="item-box-overlay"
          viewBox={`0 0 ${imageSize.width} ${imageSize.height}`}
          preserveAspectRatio="xMidYMid meet"
          aria-hidden="true"
        >
          {items.map((frameItem) => {
            const box = frameItem.boundingBox;
            if (!box) return null;
            return (
              <rect
                key={frameItem.id}
                className={frameItem.id === activeItemId ? "active" : ""}
                x={(box.xMin / 1000) * imageSize.width}
                y={(box.yMin / 1000) * imageSize.height}
                width={((box.xMax - box.xMin) / 1000) * imageSize.width}
                height={((box.yMax - box.yMin) / 1000) * imageSize.height}
                rx="5"
                vectorEffect="non-scaling-stroke"
                onMouseEnter={() => onHoverItem(frameItem.id)}
                onMouseLeave={() => onHoverItem(null)}
              />
            );
          })}
        </svg>
      )}
    </div>
  );
}

function EvidenceRow({ entry }: { entry: MarketEvidence }) {
  const content = (
    <>
      <span className={`comp-type ${entry.type}`}>{entry.type}</span>
      <span className="comp-title">{entry.title}</span>
      <strong>{entry.priceCents === null ? "—" : money(entry.priceCents, entry.currency)}</strong>
      {entry.url ? <ExternalLink size={15} /> : <span />}
      {entry.note && <small className="comp-note">{entry.note}</small>}
    </>
  );
  return entry.url ? <a href={entry.url} target="_blank" rel="noreferrer">{content}</a> : <div>{content}</div>;
}

function formatRange(item: Pick<DetectedItem, "estimatedLowCents" | "estimatedHighCents" | "currency">): string {
  if (item.estimatedLowCents === null && item.estimatedHighCents === null) return "Value pending";
  if (item.estimatedLowCents === item.estimatedHighCents || item.estimatedHighCents === null) {
    return money(item.estimatedLowCents ?? item.estimatedHighCents ?? 0, item.currency);
  }
  return `${money(item.estimatedLowCents ?? 0, item.currency)}–${money(item.estimatedHighCents, item.currency)}`;
}

function SellerPricing({ item }: { item: DetectedItem }) {
  const [copied, setCopied] = useState(false);
  const listing = [item.listingTitle, item.listingDescription].filter(Boolean).join("\n\n");
  const copyListing = async () => {
    try {
      await navigator.clipboard.writeText(listing);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section className="seller-pricing" aria-label="Seller pricing">
      <div className="price-comparison sell-prices">
        <div className="price-box resale-price">
          <span>Marketplace</span>
          <strong>{optionalMoney(item.listPriceCents, item.currency)}</strong>
        </div>
        <div className="price-box">
          <span>Lowest offer</span>
          <strong>{optionalMoney(item.minimumOfferCents, item.currency)}</strong>
        </div>
        <div className="price-box">
          <span>Yard sale</span>
          <strong>{optionalMoney(item.yardSalePriceCents, item.currency)}</strong>
        </div>
      </div>
      {listing && (
        <div className="listing-draft">
          <header>
            <h3>Marketplace listing</h3>
            <button type="button" data-export-exclude onClick={() => void copyListing()}>
              {copied ? <Check size={15} /> : <Copy size={15} />} {copied ? "Copied" : "Copy"}
            </button>
          </header>
          {item.listingTitle && <strong>{item.listingTitle}</strong>}
          {item.listingDescription && <p>{item.listingDescription}</p>}
        </div>
      )}
    </section>
  );
}

function EditionPicker({ item, onChange }: { item: DetectedItem; onChange: (selectedEditionKey: string | null) => Promise<void> }) {
  const [tipsKey, setTipsKey] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeKey = activeEditionKey(item);
  const bestKey = item.editions[0]?.key;

  const choose = async (key: string) => {
    if (key === activeKey || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onChange(key);
    } catch (editionError) {
      setError(editionError instanceof Error ? editionError.message : "Could not save the edition.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="edition-picker" aria-label="Edition">
      <h3>Which edition do you have?</h3>
      {item.editions.map((edition) => (
        <div key={edition.key} className={`edition-option${edition.key === activeKey ? " active" : ""}`}>
          <button type="button" className="edition-choose" onClick={() => void choose(edition.key)} aria-pressed={edition.key === activeKey} disabled={saving}>
            <span className="edition-label">{edition.label}</span>
            <span className="edition-likelihood">
              {edition.key === bestKey ? "Best guess · " : ""}{Math.round(edition.likelihood * 100)}%
            </span>
            <strong>
              {item.mode === "sell"
                ? `${optionalMoney(edition.listPriceCents, item.currency)} Marketplace`
                : formatRange({ ...edition, currency: item.currency })}
            </strong>
          </button>
          {edition.identificationTips && (
            <button type="button" className="edition-tips-toggle" data-export-exclude onClick={() => setTipsKey(tipsKey === edition.key ? null : edition.key)} aria-expanded={tipsKey === edition.key}>
              How to tell
            </button>
          )}
          {tipsKey === edition.key && <p className="edition-tips">{edition.identificationTips}</p>}
        </div>
      ))}
      {error && <p className="edition-error" role="alert">{error}</p>}
    </section>
  );
}

function optionalMoney(cents: number | null, currency: string): string {
  return cents === null ? "—" : money(cents, currency);
}

function money(cents: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currency || "USD",
    currencyDisplay: "narrowSymbol",
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}
