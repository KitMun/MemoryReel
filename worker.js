const REQUIRED_ENV = ["B2_KEY_ID", "B2_APPLICATION_KEY", "B2_BUCKET_ID", "KIOSK_UPLOAD_KEY", "LOCAL_WORKER_KEY"];

async function createJob(env, jobData) {
  const stmt = env.DB.prepare(
    "INSERT INTO jobs (id, video_file_path, status, guest_name, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  );
  await stmt.bind(jobData.id, jobData.videoFilePath, 'queued', jobData.guestName, jobData.durationMs, jobData.createdAt).all();
}

async function getNextJob(env) {
  const stmt = env.DB.prepare(
    "SELECT * FROM jobs WHERE status = 'queued' AND retry_count < 3 ORDER BY created_at ASC LIMIT 1"
  );
  return await stmt.first();
}

async function updateJobStatus(env, jobId, status, updates = {}) {
  const fields = ['status', ...Object.keys(updates)];
  const placeholders = fields.map(() => '?').join(', ');
  const values = [status, ...Object.values(updates), jobId];

  const setClause = fields.map(f => `${f} = ?`).join(', ');
  const stmt = env.DB.prepare(
    `UPDATE jobs SET ${setClause} WHERE id = ?`
  );
  await stmt.bind(...values).all();
}

async function getWordCloud(env) {
  const stmt = env.DB.prepare(
    "SELECT phrase, count FROM word_cloud ORDER BY count DESC"
  );
  const results = await stmt.all();
  return results.results.map(row => ({
    text: row.phrase,
    count: row.count
  }));
}

async function updateWordCloud(env, phrases) {
  const now = new Date().toISOString();
  for (const phrase of phrases) {
    const stmt = env.DB.prepare(
      "INSERT INTO word_cloud (phrase, count, updated_at) VALUES (?, 1, ?) ON CONFLICT(phrase) DO UPDATE SET count = count + 1, updated_at = ?"
    );
    await stmt.bind(phrase, now, now).all();
  }
}

async function addToReelManifest(env, segmentData) {
  const now = new Date().toISOString();
  const stmt = env.DB.prepare(
    "INSERT INTO reel_manifest (job_id, segment_path, start_ms, end_ms, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  );
  await stmt.bind(
    segmentData.job_id,
    segmentData.segment_path,
    segmentData.start_ms,
    segmentData.end_ms,
    segmentData.duration_ms,
    now
  ).all();
}

async function getReelSegments(env) {
  const stmt = env.DB.prepare(
    "SELECT * FROM reel_manifest ORDER BY created_at ASC"
  );
  const results = await stmt.all();
  return results.results;
}

async function getNextReelVersion(env) {
  const stmt = env.DB.prepare(
    "SELECT COALESCE(MAX(version), 0) + 1 as next_version FROM reel_versions"
  );
  const result = await stmt.first();
  return result.next_version;
}

async function addReelVersion(env, reelData) {
  const now = new Date().toISOString();
  const stmt = env.DB.prepare(
    "INSERT INTO reel_versions (version, reel_path, segment_count, total_duration_ms, created_at) VALUES (?, ?, ?, ?, ?)"
  );
  await stmt.bind(
    reelData.version,
    reelData.reel_path,
    reelData.segment_count,
    reelData.total_duration_ms,
    now
  ).all();
}

async function getReelVersion(env, version) {
  const stmt = env.DB.prepare(
    "SELECT * FROM reel_versions WHERE version = ?"
  );
  const result = await stmt.bind(version).first();
  return result;
}

async function getLastReelVersion(env) {
  const stmt = env.DB.prepare(
    "SELECT * FROM reel_versions ORDER BY version DESC LIMIT 1"
  );
  const result = await stmt.first();
  return result;
}

async function getCurrentReel(env) {
  const stmt = env.DB.prepare(
    "SELECT * FROM reel_versions ORDER BY version DESC LIMIT 1"
  );
  const result = await stmt.first();
  if (!result) return null;

  // Use worker proxy endpoint for private bucket access
  const reelUrl = `/api/reel/video/${result.version}`;

  return {
    version: result.version,
    reel_url: reelUrl,
    segment_count: result.segment_count,
    total_duration_ms: result.total_duration_ms,
    created_at: result.created_at
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (url.pathname === "/api/health") {
      return json({ status: "ok", service: "memoryreel-kiosk" });
    }

    if (url.pathname === "/api/uploads/b2-token" && request.method === "POST") {
      return createB2UploadToken(request, env);
    }

    if (url.pathname === "/api/uploads/b2-upload" && request.method === "POST") {
      return proxyB2Upload(request, env);
    }

    if (url.pathname === "/api/jobs/next" && request.method === "GET") {
      return getNextJobEndpoint(request, env);
    }

    if (url.pathname.match(/^\/api\/jobs\/[^/]+\/status$/) && request.method === "POST") {
      return updateJobStatusEndpoint(request, env);
    }

    if (url.pathname.match(/^\/api\/jobs\/[^/]+\/transcript$/) && request.method === "POST") {
      return uploadTranscriptEndpoint(request, env);
    }

    if (url.pathname === "/api/word-cloud" && request.method === "GET") {
      return getWordCloudEndpoint(request, env);
    }

    if (url.pathname === "/api/word-cloud/update" && request.method === "POST") {
      return updateWordCloudEndpoint(request, env);
    }

    if (url.pathname === "/api/reel/manifest" && request.method === "POST") {
      return addToReelManifestEndpoint(request, env);
    }

    if (url.pathname === "/api/reel/segments" && request.method === "GET") {
      return getReelSegmentsEndpoint(request, env);
    }

    if (url.pathname === "/api/reel/next-version" && request.method === "GET") {
      return getNextReelVersionEndpoint(request, env);
    }

    if (url.pathname === "/api/reel/version" && request.method === "POST") {
      return addReelVersionEndpoint(request, env);
    }

    if (url.pathname === "/api/reel/last-version" && request.method === "GET") {
      return getLastReelVersionEndpoint(request, env);
    }

    if (url.pathname === "/api/reel/current" && request.method === "GET") {
      return getCurrentReelEndpoint(request, env);
    }

    if (url.pathname.match(/^\/api\/reel\/video\/\d+$/) && request.method === "GET") {
      return getReelVideoEndpoint(request, env);
    }

    if (url.pathname.startsWith("/api/")) {
      return json({ error: "Not found" }, { status: 404 });
    }

    return env.ASSETS.fetch(request);
  },
};

async function createB2UploadToken(request, env) {
  const missing = REQUIRED_ENV.filter((key) => !env[key]);
  if (missing.length > 0) {
    return json(
      { error: `Missing Worker configuration: ${missing.join(", ")}` },
      { status: 500 }
    );
  }

  if (request.headers.get("X-MemoryReel-Kiosk-Key") !== env.KIOSK_UPLOAD_KEY) {
    return json({ error: "Kiosk upload key is missing or invalid" }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Expected JSON request body" }, { status: 400 });
  }

  const fileName = sanitizeFileName(body.fileName);
  if (!fileName) {
    return json({ error: "Invalid fileName" }, { status: 400 });
  }

  try {
    const authorized = await authorizeB2(env);
    const uploadTarget = await getUploadUrl(authorized, env.B2_BUCKET_ID);
    const prefix = sanitizePrefix(env.B2_FILE_PREFIX || "raw");
    const objectName = `${prefix}/${fileName}`;

    return json({
      uploadUrl: uploadTarget.uploadUrl,
      authorizationToken: uploadTarget.authorizationToken,
      fileName: objectName,
      encodedFileName: encodeB2FileName(objectName),
    });
  } catch (error) {
    return json({ error: error.message }, { status: 502 });
  }
}

async function proxyB2Upload(request, env) {
  const missing = REQUIRED_ENV.filter((key) => !env[key]);
  if (missing.length > 0) {
    return json(
      { error: `Missing Worker configuration: ${missing.join(", ")}` },
      { status: 500 }
    );
  }

  if (request.headers.get("X-MemoryReel-Kiosk-Key") !== env.KIOSK_UPLOAD_KEY) {
    return json({ error: "Kiosk upload key is missing or invalid" }, { status: 401 });
  }

  const contentType = request.headers.get("Content-Type");
  if (!contentType || !contentType.startsWith("multipart/form-data")) {
    return json({ error: "Expected multipart/form-data" }, { status: 400 });
  }

  try {
    const formData = await request.formData();
    const file = formData.get("file");
    const fileName = formData.get("fileName");
    const guestName = formData.get("guestName");
    const createdAt = formData.get("createdAt");
    const durationMs = formData.get("durationMs");

    if (!file || !fileName) {
      return json({ error: "Missing file or fileName" }, { status: 400 });
    }

    const sanitizedFileName = sanitizeFileName(fileName);
    if (!sanitizedFileName) {
      return json({ error: "Invalid fileName" }, { status: 400 });
    }

    const authorized = await authorizeB2(env);
    const uploadTarget = await getUploadUrl(authorized, env.B2_BUCKET_ID);
    const prefix = sanitizePrefix(env.B2_FILE_PREFIX || "raw");
    const objectName = `${prefix}/${sanitizedFileName}`;

    const uploadResponse = await fetch(uploadTarget.uploadUrl, {
      method: "POST",
      headers: {
        Authorization: uploadTarget.authorizationToken,
        "Content-Type": file.type || "application/octet-stream",
        "X-Bz-File-Name": encodeB2FileName(objectName),
        "X-Bz-Content-Sha1": "do_not_verify",
        "X-Bz-Info-guest-name": encodeMetadata(guestName || "anonymous"),
        "X-Bz-Info-created-at": encodeMetadata(createdAt || new Date().toISOString()),
        "X-Bz-Info-duration-ms": String(durationMs || "0"),
      },
      body: file,
    });

    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      throw new Error(`B2 upload failed: ${uploadResponse.status} ${errorText}`);
    }

    const jobId = crypto.randomUUID();
    await createJob(env, {
      id: jobId,
      videoFilePath: objectName,
      guestName: guestName || null,
      durationMs: parseInt(durationMs) || 0,
      createdAt: new Date().toISOString()
    });

    return json({ success: true, fileName: objectName, jobId });
  } catch (error) {
    return json({ error: error.message }, { status: 502 });
  }
}

async function authorizeB2(env) {
  const credentials = btoa(`${env.B2_KEY_ID}:${env.B2_APPLICATION_KEY}`);
  const response = await fetch("https://api.backblazeb2.com/b2api/v3/b2_authorize_account", {
    headers: {
      Authorization: `Basic ${credentials}`,
    },
  });

  if (!response.ok) {
    throw new Error(`B2 authorization failed: ${response.status} key ${env.B2_KEY_ID} application key ${env.B2_APPLICATION_KEY.substring(0, 8)}...`);
  }

  const data = await response.json();
  return {
    apiUrl: data.apiInfo?.storageApi?.apiUrl || data.apiUrl,
    authorizationToken: data.authorizationToken,
  };
}

async function getUploadUrl(authorized, bucketId) {
  const response = await fetch(`${authorized.apiUrl}/b2api/v3/b2_get_upload_url`, {
    method: "POST",
    headers: {
      Authorization: authorized.authorizationToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ bucketId }),
  });

  if (!response.ok) {
    throw new Error(`B2 upload URL request failed: ${response.status}`);
  }

  return response.json();
}

function sanitizeFileName(fileName) {
  if (typeof fileName !== "string") {
    return "";
  }

  const clean = fileName.replace(/[^A-Za-z0-9._-]/g, "_");
  if (!clean || clean.length > 180 || !/\.(webm|mp4)$/i.test(clean)) {
    return "";
  }

  return clean;
}

function sanitizePrefix(prefix) {
  return String(prefix)
    .split("/")
    .map((part) => part.replace(/[^A-Za-z0-9._-]/g, "_"))
    .filter(Boolean)
    .join("/") || "raw";
}

function encodeB2FileName(fileName) {
  return fileName
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function encodeMetadata(value) {
  return encodeURIComponent(value).replace(/%20/g, "+");
}

function json(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
      ...(init.headers || {}),
    },
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-MemoryReel-Kiosk-Key, X-Local-Worker-Key",
  };
}

async function getNextJobEndpoint(request, env) {
  if (request.headers.get("X-Local-Worker-Key") !== env.LOCAL_WORKER_KEY) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const job = await getNextJob(env);
    return json(job || null);
  } catch (error) {
    return json({ error: error.message }, { status: 500 });
  }
}

async function updateJobStatusEndpoint(request, env) {
  if (request.headers.get("X-Local-Worker-Key") !== env.LOCAL_WORKER_KEY) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const jobId = url.pathname.split('/')[3];
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Expected JSON request body" }, { status: 400 });
  }

  try {
    await updateJobStatus(env, jobId, body.status, body.updates || {});
    return json({ success: true });
  } catch (error) {
    return json({ error: error.message }, { status: 500 });
  }
}

async function uploadTranscriptEndpoint(request, env) {
  if (request.headers.get("X-Local-Worker-Key") !== env.LOCAL_WORKER_KEY) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const jobId = url.pathname.split('/')[3];
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Expected JSON request body" }, { status: 400 });
  }

  try {
    await updateJobStatus(env, jobId, 'completed', {
      transcript_file_path: body.transcriptPath,
      suggested_start_ms: body.suggestedStartMs,
      suggested_end_ms: body.suggestedEndMs,
      suggested_score: body.suggestedScore,
      suggested_reason: body.suggestedReason,
      completed_at: new Date().toISOString()
    });
    return json({ success: true });
  } catch (error) {
    return json({ error: error.message }, { status: 500 });
  }
}

async function getWordCloudEndpoint(request, env) {
  try {
    const words = await getWordCloud(env);
    return json({
      updated_at: new Date().toISOString(),
      words: words
    });
  } catch (error) {
    return json({ error: error.message }, { status: 500 });
  }
}

async function updateWordCloudEndpoint(request, env) {
  if (request.headers.get("X-Local-Worker-Key") !== env.LOCAL_WORKER_KEY) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Expected JSON request body" }, { status: 400 });
  }

  if (!Array.isArray(body.phrases)) {
    return json({ error: "Expected phrases array" }, { status: 400 });
  }

  try {
    await updateWordCloud(env, body.phrases);
    return json({ success: true });
  } catch (error) {
    return json({ error: error.message }, { status: 500 });
  }
}

async function addToReelManifestEndpoint(request, env) {
  if (request.headers.get("X-Local-Worker-Key") !== env.LOCAL_WORKER_KEY) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Expected JSON request body" }, { status: 400 });
  }

  try {
    await addToReelManifest(env, body);
    return json({ success: true });
  } catch (error) {
    return json({ error: error.message }, { status: 500 });
  }
}

async function getReelSegmentsEndpoint(request, env) {
  if (request.headers.get("X-Local-Worker-Key") !== env.LOCAL_WORKER_KEY) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const segments = await getReelSegments(env);
    return json(segments);
  } catch (error) {
    return json({ error: error.message }, { status: 500 });
  }
}

async function getNextReelVersionEndpoint(request, env) {
  if (request.headers.get("X-Local-Worker-Key") !== env.LOCAL_WORKER_KEY) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const version = await getNextReelVersion(env);
    return json({ version });
  } catch (error) {
    return json({ error: error.message }, { status: 500 });
  }
}

async function addReelVersionEndpoint(request, env) {
  if (request.headers.get("X-Local-Worker-Key") !== env.LOCAL_WORKER_KEY) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Expected JSON request body" }, { status: 400 });
  }

  try {
    await addReelVersion(env, body);
    return json({ success: true });
  } catch (error) {
    return json({ error: error.message }, { status: 500 });
  }
}

async function getLastReelVersionEndpoint(request, env) {
  if (request.headers.get("X-Local-Worker-Key") !== env.LOCAL_WORKER_KEY) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const lastVersion = await getLastReelVersion(env);
    return json(lastVersion || null);
  } catch (error) {
    return json({ error: error.message }, { status: 500 });
  }
}

async function getCurrentReelEndpoint(request, env) {
  try {
    const reel = await getCurrentReel(env);
    return json(reel || { error: "No reel available" });
  } catch (error) {
    return json({ error: error.message }, { status: 500 });
  }
}

async function getReelVideoEndpoint(request, env) {
  const url = new URL(request.url);
  const version = url.pathname.split('/')[4];

  try {
    const reelVersion = await getReelVersion(env, version);
    if (!reelVersion) {
      return new Response("Reel version " + version + " not found", { status: 404 });
    }

    // Authorize with B2
    const authorized = await authorizeB2(env);

    // Download file from B2
    const downloadUrl = `${authorized.apiInfo.storageApi.apiUrl}/b2api/v3/b2_download_file_by_name?bucketId=${authorized.apiInfo.storageApi.bucketId}&fileName=${encodeURIComponent(reelVersion.reel_path)}`;

    const response = await fetch(downloadUrl, {
      headers: {
        'Authorization': authorized.authorizationToken
      }
    });

    if (!response.ok) {
      return new Response(`Failed to download reel: ${response.statusText}`, { status: 500 });
    }

    // Stream the response back to client
    return new Response(response.body, {
      headers: {
        'Content-Type': 'video/mp4',
        'Cache-Control': 'public, max-age=3600'
      }
    });
  } catch (error) {
    return new Response(`Error: ${error.message}`, { status: 500 });
  }
}
