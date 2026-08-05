import os
import time
import json
from transcriber import TranscriptionWorker
from http.server import HTTPServer, SimpleHTTPRequestHandler
import threading

def main():
    with open('config.json', "r", encoding="utf-8") as f:
        config = json.load(f)

    worker = TranscriptionWorker(config)

    print("Starting local transcription worker...")
    print(f"Polling interval: {config['poll_interval_seconds']}s")
    print(f"Reel stitch interval: {config.get('reel_stitch_interval_seconds', 900)}s (default: 15 min)")
    print("Press Ctrl+C to stop")

    # Initialize timing for reel stitching
    poll_interval = config['poll_interval_seconds']
    reel_stitch_interval = config.get('reel_stitch_interval_seconds', 900)  # Default 15 minutes
    last_stitch_time = time.time()

    try:
        while True:
            # Check if it's time to stitch reel
            current_time = time.time()
            if current_time - last_stitch_time >= reel_stitch_interval:
                print(f"\n{'='*50}")
                print("Triggering scheduled reel stitching...")
                print(f"{'='*50}")
                try:
                    worker.stitch_reel()
                    last_stitch_time = current_time
                except Exception as e:
                    print(f"ERROR: Reel stitching failed: {e}")
                    # Still update time to avoid continuous errors
                    last_stitch_time = current_time

            # Poll for transcription jobs
            job = worker.poll_for_job()
            if job:
                print(f"Processing job: {job['id']}")
                success = worker.process_job(job)
                if not success:
                    print(f"Job {job['id']} failed, will retry later")

            time.sleep(poll_interval)
    except KeyboardInterrupt:
        print("\nWorker stopped")

if __name__ == "__main__":
    main()