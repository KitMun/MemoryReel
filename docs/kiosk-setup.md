# MemoryReel kiosk setup

This is the setup needed for the Part 1 kiosk recorder.

## Required Cloudflare Worker secrets

Set these values for the Worker before deploying:

```text
B2_KEY_ID
B2_APPLICATION_KEY
B2_BUCKET_ID
KIOSK_UPLOAD_KEY
```

Optional:

```text
B2_FILE_PREFIX=raw
```

The browser app never stores the B2 key. It asks the Worker for a temporary B2 upload URL/token, then uploads the clip directly to Backblaze.

`KIOSK_UPLOAD_KEY` is a shared secret for the one trusted kiosk phone. Open the deployed kiosk once with:

```text
https://your-kiosk-url.example/?setupKey=YOUR_KIOSK_UPLOAD_KEY
```

The app saves the key to that phone's local storage and removes it from the address bar. Guests will not need to type anything.

## Backblaze B2 key

Create an Application Key scoped to the wedding clips bucket.

Required capability:

```text
writeFiles
```

Use the bucket ID, not the bucket name, for `B2_BUCKET_ID`.

## Backblaze B2 CORS

Because the phone uploads directly to B2 from the browser, configure the B2 bucket CORS rules to allow the deployed kiosk origin.

For early testing, the allowed origin can be the Cloudflare Workers/Pages URL. For the event, use the final display/kiosk origin.

Allow:

```text
POST
OPTIONS
Authorization
Content-Type
X-MemoryReel-Kiosk-Key
X-Bz-File-Name
X-Bz-Content-Sha1
X-Bz-Info-guest-name
X-Bz-Info-created-at
X-Bz-Info-duration-ms
```

## Device checks

Before the wedding, test on the exact kiosk phone:

1. Camera and microphone permission prompt appears.
2. A 30-second recording is saved before upload starts.
3. Upload succeeds on normal WiFi.
4. Upload retries after toggling airplane mode off and on.
5. The B2 bucket receives files under the configured prefix.
