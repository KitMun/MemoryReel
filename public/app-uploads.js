const DB_NAME = "memoryreel-kiosk";
const DB_VERSION = 1;
const STORE_NAME = "clips";
const KIOSK_KEY_STORAGE = "memoryreel-kiosk-upload-key";

const backButton = document.querySelector("#back-button");
const clipsList = document.querySelector("#clips-list");
const retryAllButton = document.querySelector("#retry-all-button");

let db;

init();

async function init() {
  await openDb();
  await loadClips();
  setupEventListeners();
}

async function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      db = request.result;
      resolve(db);
    };
    
    request.onupgradeneeded = (event) => {
      const database = event.target.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("status", "status", { unique: false });
      }
    };
  });
}

async function getAllClips() {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.getAll();
    
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

async function deleteClip(id) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.delete(id);
    
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

async function updateClip(clip) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.put(clip);
    
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

function kioskAuthHeaders() {
  const key = localStorage.getItem(KIOSK_KEY_STORAGE);
  if (!key) {
    throw new Error("Missing kiosk upload key");
  }
  return {
    "X-Kiosk-Upload-Key": key,
  };
}

async function uploadClip(clip) {
  const nextAttempt = clip.attempts + 1;
  try {
    await updateClip({ ...clip, attempts: nextAttempt, status: "uploading" });
    renderClips();

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

    await updateClip({ ...clip, attempts: nextAttempt, status: "uploaded" });
    renderClips();
  } catch (error) {
    await updateClip({ ...clip, attempts: nextAttempt, status: "failed", lastError: error.message });
    renderClips();
  }
}

async function readError(response) {
  try {
    const text = await response.text();
    try {
      const json = JSON.parse(text);
      return json.error || text;
    } catch {
      return text;
    }
  } catch {
    return `Upload failed with status ${response.status}`;
  }
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins > 0) {
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  }
  return `${secs}s`;
}

function formatDate(isoString) {
  const date = new Date(isoString);
  return date.toLocaleString();
}

function getStatusText(status) {
  switch (status) {
    case "pending":
      return "Pending";
    case "uploading":
      return "Uploading...";
    case "uploaded":
      return "Uploaded";
    case "failed":
      return "Failed";
    default:
      return status;
  }
}

function renderClips() {
  const clips = getAllClips().then(clips => {
    if (clips.length === 0) {
      clipsList.innerHTML = '<p class="empty-message">No clips yet</p>';
      retryAllButton.style.display = "none";
      return;
    }

    const failedClips = clips.filter(c => c.status === "failed");
    retryAllButton.style.display = failedClips.length > 0 ? "flex" : "none";

    clipsList.innerHTML = clips.map(clip => `
      <div class="clip-item" data-id="${clip.id}">
        <div class="clip-thumbnail">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/>
            <line x1="7" y1="2" x2="7" y2="22"/>
            <line x1="17" y1="2" x2="17" y2="22"/>
            <line x1="2" y1="12" x2="22" y2="12"/>
            <line x1="2" y1="7" x2="7" y2="7"/>
            <line x1="2" y1="17" x2="7" y2="17"/>
            <line x1="17" y1="17" x2="22" y2="17"/>
            <line x1="17" y1="7" x2="22" y2="7"/>
          </svg>
        </div>
        <div class="clip-info">
          <div class="clip-name">${clip.fileName}</div>
          <div class="clip-meta">
            <span>${formatFileSize(clip.size)}</span>
            <span>•</span>
            <span>${formatDuration(clip.durationMs)}</span>
          </div>
          <div class="clip-meta">
            <span>${formatDate(clip.createdAt)}</span>
          </div>
          <div class="clip-status ${clip.status}">${getStatusText(clip.status)}</div>
          ${clip.lastError ? `<div class="clip-meta" style="color: #ff3b30; margin-top: 4px;">${clip.lastError}</div>` : ""}
        </div>
        <div class="clip-actions">
          ${clip.status === "failed" ? `
            <button class="clip-action-button retry" data-action="retry" data-id="${clip.id}" title="Retry upload">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M23 4v6h-6M1 20v-6h6"/>
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
              </svg>
            </button>
          ` : ""}
          <button class="clip-action-button delete" data-action="delete" data-id="${clip.id}" title="Delete clip">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            </svg>
          </button>
        </div>
      </div>
    `).join("");

    setupClipActions();
  });
}

function setupClipActions() {
  clipsList.querySelectorAll(".clip-action-button").forEach(button => {
    button.addEventListener("click", async (e) => {
      const action = button.dataset.action;
      const id = button.dataset.id;
      const clipItem = button.closest(".clip-item");

      if (action === "delete") {
        if (confirm("Delete this clip?")) {
          await deleteClip(id);
          renderClips();
        }
      } else if (action === "retry") {
        const clips = await getAllClips();
        const clip = clips.find(c => c.id === id);
        if (clip) {
          uploadClip(clip);
        }
      }
    });
  });
}

async function loadClips() {
  renderClips();
}

async function retryAllFailed() {
  const clips = await getAllClips();
  const failedClips = clips.filter(c => c.status === "failed");
  
  for (const clip of failedClips) {
    await uploadClip(clip);
  }
}

function setupEventListeners() {
  backButton.addEventListener("click", () => {
    window.location.href = "/";
  });

  retryAllButton.addEventListener("click", retryAllFailed);
}
