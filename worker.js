const REQUIRED_ENV = ["B2_KEY_ID", "B2_APPLICATION_KEY", "B2_BUCKET_ID", "KIOSK_UPLOAD_KEY"];

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

    return json({ success: true, fileName: objectName });
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
    throw new Error(`B2 authorization failed: ${response.status}`);
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
    "Access-Control-Allow-Headers": "Content-Type, X-MemoryReel-Kiosk-Key",
  };
}
