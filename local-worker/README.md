# Local Transcription Worker

This CLI worker processes video uploads from the MemoryReel kiosk using local faster-whisper transcription, eliminating the need for the OpenAI Whisper API.

## Prerequisites

- Python 3.10 or higher
- ffmpeg (must be available in PATH)
- Backblaze B2 account with bucket access
- Cloudflare Worker deployed with D1 database

## Installation

1. Navigate to the local-worker directory:
```bash
cd local-worker
```

2. Install Python dependencies:
```bash
pip install -r requirements.txt
```

3. Install ffmpeg:
- **Windows**: Download from https://ffmpeg.org/download.html and add to PATH
- **macOS**: `brew install ffmpeg`
- **Linux**: `sudo apt install ffmpeg`

## Configuration

Edit `config.json` with your credentials:

```json
{
  "worker_api_url": "https://your-worker.workers.dev",
  "local_worker_key": "your-shared-secret",
  "b2_key_id": "your-b2-key-id",
  "b2_application_key": "your-b2-app-key",
  "b2_bucket_name": "your-bucket-name",
  "whisper_model": "medium",
  "poll_interval_seconds": 30,
  "download_dir": "./downloads",
  "transcript_dir": "./transcripts"
}
```

### Configuration Fields

- `worker_api_url`: Your deployed Cloudflare Worker URL
- `local_worker_key`: Shared secret (set as LOCAL_WORKER_KEY in Worker secrets)
- `b2_key_id`: Backblaze B2 key ID
- `b2_application_key`: Backblaze B2 application key
- `b2_bucket_name`: Your B2 bucket name
- `whisper_model`: Whisper model size (small, medium, or large-v3)
- `poll_interval_seconds`: How often to check for new jobs (default: 30)
- `download_dir`: Local directory for downloaded videos
- `transcript_dir`: Local directory for transcript files

## Cloudflare Worker Setup

### 1. Create D1 Database

```bash
wrangler d1 create memoryreel-jobs
```

Note the database ID and update `wrangler.jsonc`:
```jsonc
{
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "memoryreel-jobs",
      "database_id": "<your-database-id>"
    }
  ]
}
```

### 2. Run Migration

Local development:
```bash
wrangler d1 execute memoryreel-jobs --file=../schema.sql --local
```

Production:
```bash
wrangler d1 execute memoryreel-jobs --file=../schema.sql
```

### 3. Set Worker Secrets

```bash
wrangler secret put LOCAL_WORKER_KEY
```

Enter your shared secret key when prompted.

### 4. Deploy Worker

```bash
wrangler deploy
```

## Running the Worker

Start the worker:
```bash
python main.py
```

The worker will:
1. Poll the Worker API every 30 seconds for new jobs
2. Download videos from B2
3. Extract audio using ffmpeg
4. Transcribe using faster-whisper (Mandarin Chinese)
5. Upload transcripts to B2
6. Update job status in D1 database
7. Suggest clip segments for highlight reel generation

Press Ctrl+C to stop the worker.

## Whisper Models

- **small**: Fastest, suitable for general transcription
- **medium**: Recommended balance of speed and accuracy (default)
- **large-v3**: Highest accuracy, slower inference

The medium model is recommended for Mandarin speech with names and specific vocabulary.

## Job Processing Flow

1. Kiosk uploads video to B2
2. Worker creates job in D1 database (status: queued)
3. Local worker polls for queued jobs
4. Worker downloads video, extracts audio, transcribes
5. Worker uploads transcript JSON to B2
6. Worker updates D1 job with transcript path and suggested clip segment
7. Job marked as completed (or failed with retry logic after 3 attempts)

## Troubleshooting

### ffmpeg not found
Ensure ffmpeg is installed and available in your system PATH. Test with:
```bash
ffmpeg -version
```

### B2 authentication errors
Verify your B2 credentials in config.json and that the application key has write access to the bucket.

### Worker API 401 errors
Check that LOCAL_WORKER_KEY matches between your config.json and Worker secrets.

### Transcription quality
For better name recognition, add the couple's names to the `initial_prompt` parameter in `transcriber.py`:
```python
initial_prompt="张三 李四 新婚快乐"
```

### D1 database errors
Ensure the D1 database is created and the schema migration has been run. Check wrangler.jsonc has the correct database_id.

## File Cleanup

The worker automatically cleans up downloaded video and audio files after processing. Transcript files are kept locally in the `transcript_dir` for debugging but are also uploaded to B2.
