const MAX_RECORDING_SECONDS = 30;
const DB_NAME = "memoryreel-kiosk";
const DB_VERSION = 1;
const STORE_NAME = "clips";
const KIOSK_KEY_STORAGE = "memoryreel-kiosk-upload-key";

const preview = document.querySelector("#preview");
const videoPreview = document.querySelector("#video-preview");
const recordButton = document.querySelector("#record-button");
const cancelButton = document.querySelector("#cancel-button");
const saveButton = document.querySelector("#save-button");
const countdownProgress = document.querySelector("#countdown-progress");
const landingScreen = document.querySelector("#landing-screen");
const previewScreen = document.querySelector("#preview-screen");
const uploadStatus = document.querySelector("#upload-status");
const statusText = document.querySelector("#status-text");

let mediaStream;
let mediaRecorder;
let chunks = [];
let recordingStartedAt = 0;
let countdownInterval;
let autoStopTimeout;
let currentClip = null;
let isRecording = false;
let holdTimer = null;

init();

async function init() {
  captureSetupKey();
  updateCountdown(MAX_RECORDING_SECONDS);
  await openDb();
  await startCamera();
  setupTouchAndHold();
  setupPreviewActions();
  await registerServiceWorker();
}

async function startCamera() {
  try {
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
    preview.srcObject = mediaStream;
  } catch (error) {
    console.error("Camera failed:", error);
    statusText.textContent = "Camera access required";
  }
}

function setupTouchAndHold() {
  recordButton.addEventListener("touchstart", handleTouchStart, { passive: false });
  recordButton.addEventListener("touchend", handleTouchEnd, { passive: false });
  recordButton.addEventListener("mousedown", handleTouchStart);
  recordButton.addEventListener("mouseup", handleTouchEnd);
  recordButton.addEventListener("mouseleave", handleTouchEnd);
}

function handleTouchStart(e) {
  e.preventDefault();
  if (isRecording) return;
  
  holdTimer = setTimeout(() => {
    startRecording();
  }, 200);
}

function handleTouchEnd(e) {
  e.preventDefault();
  if (holdTimer) {
    clearTimeout(holdTimer);
    holdTimer = null;
  }
  
  if (isRecording) {
    stopRecording();
  }
}

function setupPreviewActions() {
  cancelButton.addEventListener("click", cancelRecording);
  saveButton.addEventListener("click", saveRecording);
}

async function startRecording() {
  if (!mediaStream) {
    await startCamera();
  }

  isRecording = true;
  recordButton.classList.add("recording");
  
  const mimeType = pickMimeType();
  chunks = [];
  
  mediaRecorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : undefined);
  mediaRecorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) {
      chunks.push(event.data);
    }
  });
  mediaRecorder.addEventListener("stop", handleRecordingStopped, { once: true });

  recordingStartedAt = Date.now();
  mediaRecorder.start(1000);

  countdownInterval = setInterval(updateRecordingCountdown, 100);
  autoStopTimeout = setTimeout(stopRecording, MAX_RECORDING_SECONDS * 1000);
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
}

async function handleRecordingStopped() {
  clearInterval(countdownInterval);
  clearTimeout(autoStopTimeout);
  
  isRecording = false;
  recordButton.classList.remove("recording");
  
  const durationMs = Date.now() - recordingStartedAt;
  const mimeType = mediaRecorder.mimeType || "video/webm";
  const extension = mimeType.includes("mp4") ? "mp4" : "webm";
  const clip = new Blob(chunks, { type: mimeType });

  if (clip.size === 0) {
    updateCountdown(MAX_RECORDING_SECONDS);
    return;
  }

  const now = new Date();
  const fileName = `${formatTimestamp(now)}_clip.${extension}`;
  
  currentClip = {
    id: crypto.randomUUID(),
    fileName,
    createdAt: now.toISOString(),
    durationMs,
    mimeType,
    size: clip.size,
    blob: clip,
  };

  showPreview(clip);
}

function showPreview(blob) {
  const url = URL.createObjectURL(blob);
  videoPreview.src = url;
  videoPreview.loop = true;
  videoPreview.play();
  
  landingScreen.classList.remove("active");
  previewScreen.classList.add("active");
}

function cancelRecording() {
  videoPreview.pause();
  videoPreview.src = "";
  URL.revokeObjectURL(videoPreview.src);
  
  currentClip = null;
  chunks = [];
  
  previewScreen.classList.remove("active");
  landingScreen.classList.add("active");
  updateCountdown(MAX_RECORDING_SECONDS);
}

async function saveRecording() {
  if (!currentClip) return;

  videoPreview.pause();
  videoPreview.src = "";
  URL.revokeObjectURL(videoPreview.src);
  
  const record = {
    ...currentClip,
    attempts: 0,
    status: "pending",
  };

  await saveClip(record);
  
  currentClip = null;
  chunks = [];
  
  previewScreen.classList.remove("active");
  landingScreen.classList.add("active");
  updateCountdown(MAX_RECORDING_SECONDS);
  
  showUploadStatus("Uploading...");
  await processUploadQueue();
  hideUploadStatus();
}

function updateRecordingCountdown() {
  const elapsedSeconds = (Date.now() - recordingStartedAt) / 1000;
  const remainingSeconds = Math.max(0, MAX_RECORDING_SECONDS - elapsedSeconds);
  updateCountdown(remainingSeconds);
}

function updateCountdown(seconds) {
  const circumference = 2 * Math.PI * 46;
  const progress = seconds / MAX_RECORDING_SECONDS;
  const offset = circumference * (1 - progress);
  countdownProgress.style.strokeDashoffset = offset;
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
  const clips = await getPendingClips();
  for (const clip of clips) {
    await uploadClip(clip);
  }
}

async function uploadClip(clip) {
  const nextAttempt = clip.attempts + 1;
  try {
    await updateClip({ ...clip, attempts: nextAttempt, status: "uploading" });
    showUploadStatus("Uploading your wish...");

    const formData = new FormData();
    formData.append("file", clip.blob, clip.fileName);
    formData.append("fileName", clip.fileName);
    formData.append("guestName", "");
    formData.append("createdAt", clip.createdAt);
    formData.append("durationMs", String(clip.durationMs));

    const uploadResponse = await fetch("/api/uploads/b2-upload", {
      method: "POST",
      headers: {
        ...kioskAuthHeaders(),
      },
      body: formData,
    });

    if (!uploadResponse.ok) {
      throw new Error(await readError(uploadResponse));
    }

    await markUploaded(clip.id);
  } catch (error) {
    await updateClip({ ...clip, attempts: nextAttempt, status: "pending", lastError: error.message });
    showUploadStatus("Upload failed. Please try again.");
    setTimeout(hideUploadStatus, 3000);
  }
}

function showUploadStatus(message) {
  statusText.textContent = message;
  uploadStatus.classList.add("active");
}

function hideUploadStatus() {
  uploadStatus.classList.remove("active");
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

async function readError(response) {
  const text = await response.text();
  return text || `${response.status} ${response.statusText}`;
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
