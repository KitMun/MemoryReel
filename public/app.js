const MAX_RECORDING_SECONDS = 30;
const DB_NAME = "memoryreel-kiosk";
const DB_VERSION = 1;
const STORE_NAME = "clips";
const KIOSK_KEY_STORAGE = "memoryreel-kiosk-upload-key";

const preview = document.querySelector("#preview");
const emptyState = document.querySelector("#empty-state");
const countdown = document.querySelector("#countdown");
const recordButton = document.querySelector("#record-button");
const stopButton = document.querySelector("#stop-button");
const retryButton = document.querySelector("#retry-button");
const guestNameInput = document.querySelector("#guest-name");
const statusEl = document.querySelector("#status");
const pendingCountEl = document.querySelector("#pending-count");
const uploadedCountEl = document.querySelector("#uploaded-count");

let mediaStream;
let mediaRecorder;
let chunks = [];
let recordingStartedAt = 0;
let countdownInterval;
let autoStopTimeout;
let uploadInProgress = false;

recordButton.addEventListener("click", startRecording);
stopButton.addEventListener("click", stopRecording);
retryButton.addEventListener("click", () => processUploadQueue());
window.addEventListener("online", () => processUploadQueue());

init();

async function init() {
  captureSetupKey();
  updateCountdown(MAX_RECORDING_SECONDS);
  await openDb();
  await refreshQueueStats();
  await registerServiceWorker();
  processUploadQueue();
}

async function startRecording() {
  try {
    setStatus("Requesting camera and microphone...");
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
      },
      video: {
        facingMode: "user",
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    });

    const mimeType = pickMimeType();
    chunks = [];
    preview.srcObject = mediaStream;
    emptyState.classList.add("hidden");

    mediaRecorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : undefined);
    mediaRecorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    });
    mediaRecorder.addEventListener("stop", handleRecordingStopped, { once: true });

    recordingStartedAt = Date.now();
    mediaRecorder.start(1000);
    recordButton.disabled = true;
    stopButton.disabled = false;
    guestNameInput.disabled = true;
    setStatus("Recording...");

    countdownInterval = window.setInterval(updateRecordingCountdown, 250);
    autoStopTimeout = window.setTimeout(stopRecording, MAX_RECORDING_SECONDS * 1000);
  } catch (error) {
    setStatus(`Camera or microphone failed: ${error.message}`);
    resetRecorderControls();
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
}

async function handleRecordingStopped() {
  window.clearInterval(countdownInterval);
  window.clearTimeout(autoStopTimeout);
  stopMediaTracks();

  const durationMs = Date.now() - recordingStartedAt;
  const mimeType = mediaRecorder.mimeType || "video/webm";
  const extension = mimeType.includes("mp4") ? "mp4" : "webm";
  const clip = new Blob(chunks, { type: mimeType });

  if (clip.size === 0) {
    setStatus("No video was captured. Please try again.");
    resetRecorderControls();
    return;
  }

  const now = new Date();
  const fileName = `${formatTimestamp(now)}_clip.${extension}`;
  const record = {
    id: crypto.randomUUID(),
    fileName,
    guestName: guestNameInput.value.trim(),
    createdAt: now.toISOString(),
    durationMs,
    mimeType,
    size: clip.size,
    attempts: 0,
    status: "pending",
    blob: clip,
  };

  await saveClip(record);
  setStatus("Saved on this phone. Uploading in the background...");
  guestNameInput.value = "";
  resetRecorderControls();
  await refreshQueueStats();
  processUploadQueue();
}

function resetRecorderControls() {
  mediaRecorder = undefined;
  chunks = [];
  preview.srcObject = null;
  emptyState.classList.remove("hidden");
  recordButton.disabled = false;
  stopButton.disabled = true;
  guestNameInput.disabled = false;
  updateCountdown(MAX_RECORDING_SECONDS);
}

function stopMediaTracks() {
  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
  }
  mediaStream = undefined;
}

function updateRecordingCountdown() {
  const elapsedSeconds = Math.floor((Date.now() - recordingStartedAt) / 1000);
  updateCountdown(Math.max(0, MAX_RECORDING_SECONDS - elapsedSeconds));
}

function updateCountdown(seconds) {
  const mins = String(Math.floor(seconds / 60)).padStart(2, "0");
  const secs = String(seconds % 60).padStart(2, "0");
  countdown.textContent = `${mins}:${secs}`;
}

function pickMimeType() {
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
    "video/mp4",
  ];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) || "";
}

async function processUploadQueue() {
  if (uploadInProgress || !navigator.onLine) {
    return;
  }

  uploadInProgress = true;
  try {
    const clips = await getPendingClips();
    for (const clip of clips) {
      await uploadClip(clip);
      await refreshQueueStats();
    }
  } finally {
    uploadInProgress = false;
  }
}

async function uploadClip(clip) {
  const nextAttempt = clip.attempts + 1;
  try {
    await updateClip({ ...clip, attempts: nextAttempt, status: "uploading" });
    setStatus(`Uploading ${clip.fileName}...`);

    const formData = new FormData();
    formData.append("file", clip.blob, clip.fileName);
    formData.append("fileName", clip.fileName);
    formData.append("guestName", clip.guestName || "");
    formData.append("createdAt", clip.createdAt);
    formData.append("durationMs", String(clip.durationMs));

    console.log("Uploading to /api/uploads/b2-upload");
    console.log("Auth headers:", kioskAuthHeaders());
    console.log("File size:", clip.blob.size);
    console.log("File name:", clip.fileName);

    const uploadResponse = await fetch("/api/uploads/b2-upload", {
      method: "POST",
      headers: {
        ...kioskAuthHeaders(),
      },
      body: formData,
    });

    console.log("Response status:", uploadResponse.status);
    console.log("Response ok:", uploadResponse.ok);

    if (!uploadResponse.ok) {
      const errorText = await readError(uploadResponse);
      console.error("Upload failed:", errorText);
      throw new Error(errorText);
    }

    await markUploaded(clip.id);
    setStatus("Upload complete. Ready for the next guest.");
  } catch (error) {
    await updateClip({ ...clip, attempts: nextAttempt, status: "pending", lastError: error.message });
    setStatus(`Upload paused: ${error.message}`);
    return;
  }
}

function captureSetupKey() {
  const url = new URL(window.location.href);
  const setupKey = url.searchParams.get("setupKey");
  if (!setupKey) {
    return;
  }

  window.localStorage.setItem(KIOSK_KEY_STORAGE, setupKey);
  url.searchParams.delete("setupKey");
  window.history.replaceState({}, "", url);
}

function kioskAuthHeaders() {
  const kioskKey = window.localStorage.getItem(KIOSK_KEY_STORAGE);
  return kioskKey ? { "X-MemoryReel-Kiosk-Key": kioskKey } : {};
}

function encodeMetadata(value) {
  return encodeURIComponent(value).replace(/%20/g, "+");
}

async function readError(response) {
  const text = await response.text();
  return text || `${response.status} ${response.statusText}`;
}

async function refreshQueueStats() {
  const clips = await getAllClips();
  pendingCountEl.textContent = clips.filter((clip) => clip.status !== "uploaded").length;
  uploadedCountEl.textContent = clips.filter((clip) => clip.status === "uploaded").length;
}

function setStatus(message) {
  statusEl.textContent = message;
}

function formatTimestamp(date) {
  return date.toISOString().replace(/:/g, "-").replace(/\.\d{3}Z$/, "Z");
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.addEventListener("upgradeneeded", () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

async function withStore(mode, callback) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, mode);
    const store = transaction.objectStore(STORE_NAME);
    const result = callback(store);
    transaction.addEventListener("complete", () => resolve(result));
    transaction.addEventListener("error", () => reject(transaction.error));
  });
}

async function saveClip(record) {
  await withStore("readwrite", (store) => store.put(record));
}

async function updateClip(record) {
  await withStore("readwrite", (store) => store.put(record));
}

async function markUploaded(id) {
  const clip = await getClip(id);
  if (!clip) {
    return;
  }
  await updateClip({
    ...clip,
    blob: undefined,
    status: "uploaded",
    uploadedAt: new Date().toISOString(),
  });
}

async function getClip(id) {
  return withRequest((store) => store.get(id));
}

async function getAllClips() {
  return withRequest((store) => store.getAll());
}

async function getPendingClips() {
  const clips = await getAllClips();
  return clips
    .filter((clip) => clip.status === "pending" || clip.status === "uploading")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

async function withRequest(callback) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const request = callback(transaction.objectStore(STORE_NAME));
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

async function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    try {
      await navigator.serviceWorker.register("/service-worker.js");
    } catch {
      // Recording still works without offline shell caching.
    }
  }
}
