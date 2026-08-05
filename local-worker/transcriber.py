import os
import json
import requests
import subprocess

from b2sdk.v1 import InMemoryAccountInfo, B2Api
from faster_whisper import WhisperModel
import datetime
from difflib import SequenceMatcher
from opencc import OpenCC

class TranscriptionWorker:
    def __init__(self, config):
        self.config = config
        self.model = WhisperModel(config['whisper_model'], device="cpu", compute_type="int8")
        self.b2_api = self._init_b2()
        self.blessing_dict = self._load_blessing_dictionary()
        self.couple_names = self._load_couple_names()

    def _init_b2(self):
        info = InMemoryAccountInfo()
        b2 = B2Api(info)
        b2.authorize_account(
            "production",
            self.config['b2_key_id'],
            self.config['b2_application_key']
        )
        return b2

    def _load_blessing_dictionary(self):
        dict_path = os.path.join(os.path.dirname(__file__), 'blessing_dictionary.json')
        with open(dict_path, 'r', encoding='utf-8') as f:
            return json.load(f)

    def _load_couple_names(self):
        couple_config = self.config.get('couple_names', {})
        return couple_config

    def poll_for_job(self):
        response = requests.get(
            f"{self.config['worker_api_url']}/api/jobs/next",
            headers={"X-Local-Worker-Key": self.config['local_worker_key']}
        )
        if response.status_code == 200:
            return response.json()
        return None

    def process_job(self, job):
        job_id = job['id']
        print(f"DEBUG: Processing job {job_id}...")

        # Update status to processing
        self._update_job_status(job_id, 'processing', {'started_at': datetime.datetime.utcnow().isoformat()})
        print(f"DEBUG: Job status updated to 'processing'")

        try:
            # Clear all files in /downloads before downloading new video/audio
            for filename in os.listdir(self.config['download_dir']):
                file_path = os.path.join(self.config['download_dir'], filename)
                if os.path.isfile(file_path):
                    os.remove(file_path)
                    print(f"DEBUG: Removed existing file: {file_path}")

            # Download video from B2
            print(f"DEBUG: Downloading video from B2: {job['video_file_path']}")
            video_path = self._download_from_b2(job['video_file_path'])
            print(f"DEBUG: Video downloaded to: {video_path}")

            # Extract audio using ffmpeg
            print(f"DEBUG: Extracting audio...")
            audio_path = self._extract_audio(video_path)
            print(f"DEBUG: Audio extracted to: {audio_path}")

            # Transcribe with faster-whisper
            transcript_data = self._transcribe(audio_path)

            # Upload transcript to B2
            print(f"DEBUG: Uploading transcript to B2...")
            transcript_path = self._upload_transcript(transcript_data, job_id)
            print(f"DEBUG: Transcript uploaded to: {transcript_path}")

            # Calculate suggested clip segment
            print(f"DEBUG: Calculating suggested clip segment...")
            suggestion = self._suggest_clip_segment(transcript_data)
            print(f"DEBUG: Suggested clip: {suggestion['start_ms']}ms - {suggestion['end_ms']}ms (score: {suggestion['score']})")

            # Update word cloud with blessing phrases
            print(f"DEBUG: Updating word cloud...")
            self._update_word_cloud(transcript_data)
            print(f"DEBUG: Word cloud updated")

            # Extract video segment for highlight reel
            print(f"DEBUG: Extracting video segment for highlight reel...")
            segment_path = self._extract_video_segment(video_path, suggestion['start_ms'], suggestion['end_ms'], job_id)
            print(f"DEBUG: Video segment extracted to: {segment_path}")

            # Add segment to reel manifest
            print(f"DEBUG: Adding segment to reel manifest...")
            self._add_to_reel_manifest(job_id, segment_path, suggestion['start_ms'], suggestion['end_ms'])
            print(f"DEBUG: Segment added to reel manifest")

            # Update job as completed
            print(f"DEBUG: Updating job status to 'completed'...")
            self._update_job_status(job_id, 'completed', {
                'transcript_file_path': transcript_path,
                'suggested_start_ms': suggestion['start_ms'],
                'suggested_end_ms': suggestion['end_ms'],
                'suggested_score': suggestion['score'],
                'suggested_reason': suggestion['reason'],
                'completed_at': datetime.datetime.utcnow().isoformat()
            })
            print(f"DEBUG: Job {job_id} completed successfully!")

            # Cleanup local files
            print(f"DEBUG: Cleaning up local files...")
            self._cleanup_files(video_path, audio_path, segment_path if 'segment_path' in locals() else None)

            return True

        except Exception as e:
            # Increment retry count
            new_retry_count = job.get('retry_count', 0) + 1

            # Mark as failed only after 3 retries, otherwise keep as queued for retry
            if new_retry_count >= 3:
                self._update_job_status(job_id, 'failed', {
                    'error_message': str(e),
                    'retry_count': new_retry_count
                })
            else:
                self._update_job_status(job_id, 'queued', {
                    'error_message': str(e),
                    'retry_count': new_retry_count
                })
            return False

    def _download_from_b2(self, file_path):
        # Use B2 REST API directly via requests
        # First authorize to get download URL

        auth_response = requests.get(
            "https://api.backblazeb2.com/b2api/v3/b2_authorize_account",
            auth=(self.config['b2_key_id'], self.config['b2_application_key']),
        )
        if not auth_response.ok:
            print(f"DEBUG: Auth response: {auth_response.text}")
        auth_response.raise_for_status()
        auth_data = auth_response.json()

        # Use public download URL format
        download_url = auth_data['apiInfo']['storageApi']['downloadUrl']
        auth_token = auth_data['authorizationToken']
        bucket_name = self.config['b2_bucket_name']

        url = f"{download_url}/file/{bucket_name}/{file_path}"

        print(f"DEBUG: Downloading from: {url}")

        # Download the file
        response = requests.get(
            url,
            headers={"Authorization": auth_token},
            stream=True,
        )
        print(f"DEBUG: Download response status: {response.status_code}")
        if not response.ok:
            print(f"DEBUG: Download response: {response.text}")
        response.raise_for_status()

        local_path = os.path.join(self.config['download_dir'], os.path.basename(file_path))
        os.makedirs(self.config['download_dir'], exist_ok=True)

        with open(local_path, 'wb') as f:
            for chunk in response.iter_content(chunk_size=8192):
                f.write(chunk)

        return local_path

    def _extract_audio(self, video_path):
        audio_path = video_path.rsplit('.', 1)[0] + '.wav'
        subprocess.run(
            ["ffmpeg", "-i", video_path, "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1", audio_path],
            check=True,
            capture_output=True
        )
        return audio_path

    def _transcribe(self, audio_path):
        print(f"DEBUG: Starting transcription with faster-whisper...")

        cc = OpenCC("t2s")

        # Build initial prompt with couple's names
        initial_prompt = ""
        if self.couple_names:
            groom_chinese = self.couple_names.get('groom', {}).get('chinese', '')
            bride_chinese = self.couple_names.get('bride', {}).get('chinese', '')
            if groom_chinese and bride_chinese:
                initial_prompt = f"人名：{groom_chinese} {bride_chinese}"
                print(f"DEBUG: initial prompt: {initial_prompt}")

        initial_prompt = "人名：嘉豪 佳来"
        initial_prompt = cc.convert(initial_prompt)

        segments, info = self.model.transcribe(
            audio_path,
            language="zh",
            word_timestamps=True,
            initial_prompt=initial_prompt,
            vad_filter=True,
            beam_size=5,
            condition_on_previous_text=True,
        )

        print(f"DEBUG: Detected language: {info.language} (confidence: {info.language_probability:.2f})")

        result = {
            'language': info.language,
            'language_probability': info.language_probability,
            'segments': []
        }

        segment_count = 0
        for segment in segments:

            # Convert from Traditional to Simplified Chinese
            segment.text = cc.convert(segment.text)
            for w in segment.words:
                w.word = cc.convert(w.word)

            segment_count += 1
            if segment_count % 10 == 0:
                print(f"DEBUG: Processed {segment_count} segments...")
            result['segments'].append({
                'start': segment.start,
                'end': segment.end,
                'text': segment.text,
                'words': [{'start': w.start, 'end': w.end, 'word': w.word} for w in segment.words]
            })
            print(f"DEBUG: Segment: {segment.text}")

        print(f"DEBUG: Transcription complete. Total segments: {segment_count}")
        return result

    def _segment_phrases_by_pauses(self, transcript_data, pause_threshold=0.5):
        """Segment transcript into phrases based on pause gaps between words."""
        phrases = []
        current_phrase_words = []
        current_phrase_start = None

        for segment in transcript_data['segments']:
            for i, word in enumerate(segment['words']):
                if current_phrase_start is None:
                    current_phrase_start = word['start']
                    current_phrase_words = [word]
                else:
                    # Check pause gap between consecutive words
                    prev_word = current_phrase_words[-1]
                    gap = word['start'] - prev_word['end']

                    if gap >= pause_threshold:
                        # End current phrase
                        if current_phrase_words:
                            phrases.append({
                                'start': current_phrase_start,
                                'end': current_phrase_words[-1]['end'],
                                'words': current_phrase_words,
                                'text': ''.join([w['word'] for w in current_phrase_words])  # Chinese: no space
                            })
                        # Start new phrase
                        current_phrase_start = word['start']
                        current_phrase_words = [word]
                    else:
                        # Continue current phrase
                        current_phrase_words.append(word)

            # End phrase at segment boundary if we have words
            if current_phrase_words:
                phrases.append({
                    'start': current_phrase_start,
                    'end': current_phrase_words[-1]['end'],
                    'words': current_phrase_words,
                    'text': ''.join([w['word'] for w in current_phrase_words])
                })
                current_phrase_words = []
                current_phrase_start = None

        return phrases

    def _fuzzy_match_name(self, text, name_config, threshold=0.7):
        """Fuzzy match couple's names using pinyin and Chinese characters."""
        if not name_config:
            return False

        chinese = name_config.get('chinese', '')
        pinyin = name_config.get('pinyin', '')

        # Direct Chinese match
        if chinese and chinese in text:
            return True

        # Fuzzy pinyin match
        if pinyin:
            # Remove spaces and convert to lowercase for comparison
            pinyin_normalized = pinyin.replace(' ', '');

            # Check if any part of the pinyin appears in the text
            # This is a simple check - could be enhanced with proper pinyin conversion
            if pinyin_normalized in text.lower():
                return True

        return False

    def _match_blessing_phrases(self, text):
        """Match text against blessing dictionary and return matched phrases with scores."""
        matched = []
        for item in self.blessing_dict:
            phrase = item['phrase']
            weight = item.get('weight', 1)

            if phrase in text:
                matched.append({
                    'phrase': phrase,
                    'weight': weight
                })
        return matched

    def _update_word_cloud(self, transcript_data):
        """Extract blessing phrases and update word cloud via Worker API."""
        # Segment phrases
        phrases = self._segment_phrases_by_pauses(transcript_data, pause_threshold=0.5)

        # Extract unique blessing phrases
        blessing_phrases = set()
        for phrase in phrases:
            text = phrase['text']
            matched = self._match_blessing_phrases(text)
            if matched:
                print(f"DEBUG: Phrase '{text}' matched {len(matched)} blessing phrases: {[m['phrase'] for m in matched]}")
            for match in matched:
                blessing_phrases.add(match['phrase'])

        # Also check for couple's names
        for phrase in phrases:
            text = phrase['text']
            if self._fuzzy_match_name(text, self.couple_names.get('groom', {})):
                groom_chinese = self.couple_names.get('groom', {}).get('chinese', '')
                if groom_chinese:
                    blessing_phrases.add(groom_chinese)
                    print(f"DEBUG: Matched groom name: {groom_chinese}")
            if self._fuzzy_match_name(text, self.couple_names.get('bride', {})):
                bride_chinese = self.couple_names.get('bride', {}).get('chinese', '')
                if bride_chinese:
                    blessing_phrases.add(bride_chinese)
                    print(f"DEBUG: Matched bride name: {bride_chinese}")

        # Send to Worker API
        if blessing_phrases:
            print(f"DEBUG: Sending {len(blessing_phrases)} unique phrases to word cloud: {list(blessing_phrases)}")
            response = requests.post(
                f"{self.config['worker_api_url']}/api/word-cloud/update",
                headers={"X-Local-Worker-Key": self.config['local_worker_key']},
                json={'phrases': list(blessing_phrases)}
            )
            response.raise_for_status()
            print(f"DEBUG: Updated word cloud successfully")
        else:
            print(f"DEBUG: No blessing phrases found to update word cloud")

    def _suggest_clip_segment(self, transcript_data):
        """Suggest the best clip segment based on scoring algorithm."""
        phrases = self._segment_phrases_by_pauses(transcript_data, pause_threshold=0.5)

        if not phrases:
            return {
                'start_ms': 0,
                'end_ms': 0,
                'score': 0,
                'reason': 'No segments found'
            }

        # Special case: if total clip is very short (<=20s), use whole clip
        total_duration = phrases[-1]['end'] - phrases[0]['start']
        if total_duration <= 20:
            padding_ms = 200
            start_ms = max(0, phrases[0]['start'] * 1000 - padding_ms)
            end_ms = phrases[-1]['end'] * 1000 + padding_ms
            return {
                'start_ms': start_ms,
                'end_ms': end_ms,
                'score': 0,
                'reason': 'Short clip - using whole clip'
            }

        # Score each phrase
        best_phrase = None
        best_score = float('-inf')

        for phrase in phrases:
            duration = phrase['end'] - phrase['start']
            text = phrase['text']

            score = 0

            # Name match: +5 points
            if self._fuzzy_match_name(text, self.couple_names.get('groom', {})):
                score += 5
            if self._fuzzy_match_name(text, self.couple_names.get('bride', {})):
                score += 5

            # Blessing/emotion keyword match: +2 each
            matched_blessings = self._match_blessing_phrases(text)
            for match in matched_blessings:
                score += match['weight'] * 2

            # Duration scoring
            if 1.5 <= duration <= 5:
                score += 3  # Goldilocks range
            elif 0.8 <= duration < 1.5:
                score += 1  # Acceptable but short
            elif duration < 0.8:
                score -= 3  # Too short
            elif duration > 6:
                score -= 3  # Too long

            # Exclamation-style words bonus: +1 each
            exclamation_words = ['爱', '恭喜', '祝福', '幸福', '快乐', '永远', '甜蜜', '美丽', '开心', '美满']
            for word in exclamation_words:
                if word in text:
                    score += 1

            if score > best_score:
                best_score = score
                best_phrase = phrase

        # Safe fallback: if no phrase scores above 0, use first reasonable phrase
        if best_score <= 0:
            for phrase in phrases:
                duration = phrase['end'] - phrase['start']
                if duration >= 1.5:
                    best_phrase = phrase
                    best_score = 0
                    break

        if best_phrase:
            # Add padding (150-200ms)
            padding_ms = 150
            start_ms = max(0, best_phrase['start'] * 1000 - padding_ms)
            end_ms = best_phrase['end'] * 1000 + padding_ms

            return {
                'start_ms': start_ms,
                'end_ms': end_ms,
                'score': best_score,
                'reason': f"Best scoring phrase ({best_score} points)"
            }

        # Ultimate fallback
        first = phrases[0]
        return {
            'start_ms': first['start'] * 1000,
            'end_ms': first['end'] * 1000,
            'score': 0,
            'reason': 'Fallback to first segment (no phrases found)'
        }

    def _upload_transcript(self, transcript_data, job_id):
        transcript_json = json.dumps(transcript_data, ensure_ascii=False)
        transcript_path = f"transcripts/{job_id}.json"

        # Use B2 REST API directly for upload
        auth_response = requests.get(
            "https://api.backblazeb2.com/b2api/v3/b2_authorize_account",
            auth=(self.config['b2_key_id'], self.config['b2_application_key'])
        )
        auth_response.raise_for_status()
        auth_data = auth_response.json()

        # Bucket ID is already in auth response for restricted application keys
        bucket_id = auth_data['apiInfo']['storageApi']['bucketId']

        # Get upload URL
        upload_url_response = requests.post(
            f"{auth_data['apiInfo']['storageApi']['apiUrl']}/b2api/v3/b2_get_upload_url",
            headers={'Authorization': auth_data['authorizationToken']},
            json={'bucketId': bucket_id}
        )
        upload_url_response.raise_for_status()
        upload_data = upload_url_response.json()

        # Upload the file
        upload_response = requests.post(
            upload_data['uploadUrl'],
            headers={
                'Authorization': upload_data['authorizationToken'],
                'X-Bz-File-Name': transcript_path,
                'X-Bz-Content-Sha1': 'do_not_verify',
                'Content-Type': 'application/json'
            },
            data=transcript_json.encode('utf-8')
        )
        upload_response.raise_for_status()

        return transcript_path

    def _update_job_status(self, job_id, status, updates):
        response = requests.post(
            f"{self.config['worker_api_url']}/api/jobs/{job_id}/status",
            headers={"X-Local-Worker-Key": self.config['local_worker_key']},
            json={'status': status, 'updates': updates}
        )
        response.raise_for_status()

    def _cleanup_files(self, *paths):
        for path in paths:
            if path and os.path.exists(path):
                os.remove(path)

    def _extract_video_segment(self, video_path, start_ms, end_ms, job_id):
        """Extract a video segment using ffmpeg based on suggested timestamps."""
        segment_path = os.path.join(self.config['download_dir'], f"segment_{job_id}.mp4")

        # Convert milliseconds to seconds for ffmpeg
        start_sec = start_ms / 1000
        duration_sec = (end_ms - start_ms) / 1000

        # Use ffmpeg to extract segment with re-encoding for precise cuts
        subprocess.run(
            [
                "ffmpeg",
                "-i", video_path,
                "-ss", str(start_sec),
                "-t", str(duration_sec),
                "-c:v", "libx264",
                "-c:a", "aac",
                "-y",  # Overwrite output file if exists
                segment_path
            ],
            check=True,
            capture_output=True
        )

        return segment_path

    def _add_to_reel_manifest(self, job_id, segment_path, start_ms, end_ms):
        """Add segment info to D1 reel_manifest table."""
        # Upload segment to B2
        segment_b2_path = f"segments/{job_id}.mp4"
        self._upload_segment_to_b2(segment_path, segment_b2_path)

        # Calculate duration
        duration_ms = end_ms - start_ms

        # Add to D1 via Worker API
        response = requests.post(
            f"{self.config['worker_api_url']}/api/reel/manifest",
            headers={"X-Local-Worker-Key": self.config['local_worker_key']},
            json={
                'job_id': job_id,
                'segment_path': segment_b2_path,
                'start_ms': start_ms,
                'end_ms': end_ms,
                'duration_ms': duration_ms
            }
        )
        response.raise_for_status()

    def _upload_segment_to_b2(self, local_path, b2_path):
        """Upload video segment to B2 using REST API."""
        # Use B2 REST API directly for upload
        auth_response = requests.get(
            "https://api.backblazeb2.com/b2api/v3/b2_authorize_account",
            auth=(self.config['b2_key_id'], self.config['b2_application_key'])
        )
        auth_response.raise_for_status()
        auth_data = auth_response.json()

        # Bucket ID is already in auth response for restricted application keys
        bucket_id = auth_data['apiInfo']['storageApi']['bucketId']

        # Get upload URL
        upload_url_response = requests.post(
            f"{auth_data['apiInfo']['storageApi']['apiUrl']}/b2api/v3/b2_get_upload_url",
            headers={'Authorization': auth_data['authorizationToken']},
            json={'bucketId': bucket_id}
        )
        upload_url_response.raise_for_status()
        upload_data = upload_url_response.json()

        # Read file and upload
        with open(local_path, 'rb') as f:
            file_data = f.read()

        upload_response = requests.post(
            upload_data['uploadUrl'],
            headers={
                'Authorization': upload_data['authorizationToken'],
                'X-Bz-File-Name': b2_path,
                'X-Bz-Content-Sha1': 'do_not_verify',
                'Content-Type': 'video/mp4'
            },
            data=file_data
        )
        upload_response.raise_for_status()

    def stitch_reel(self):
        # Clear all files in /downloads before downloading new video/audio
        for filename in os.listdir(self.config['download_dir']):
            file_path = os.path.join(self.config['download_dir'], filename)
            if os.path.isfile(file_path):
                os.remove(file_path)
                print(f"DEBUG: Removed existing file: {file_path}")

        """Stitch video segments into a highlight reel with FIFO rolling window (3-min cap)."""
        print(f"DEBUG: Starting reel stitching...")

        # Check if there are new segments since last reel
        response = requests.get(
            f"{self.config['worker_api_url']}/api/reel/last-version",
            headers={"X-Local-Worker-Key": self.config['local_worker_key']}
        )
        response.raise_for_status()
        last_version = response.json()

        # Get all segments from reel_manifest
        response = requests.get(
            f"{self.config['worker_api_url']}/api/reel/segments",
            headers={"X-Local-Worker-Key": self.config['local_worker_key']}
        )
        response.raise_for_status()
        segments = response.json()

        if not segments:
            print(f"DEBUG: No segments to stitch")
            return

        # Check if there are new segments since last reel
        if last_version:
            last_created_at = last_version.get('created_at')
            new_segments = [seg for seg in segments if seg['created_at'] > last_created_at]
            if not new_segments:
                print(f"DEBUG: No new segments since last reel (last: {last_created_at}), skipping stitch")
                return
            print(f"DEBUG: Found {len(new_segments)} new segments since last reel")
        else:
            print(f"DEBUG: No previous reel version found, proceeding with initial stitch")

        # Build FIFO rolling window: most recent segments within 3-minute cap
        # Process from newest to oldest
        selected = []
        total_duration = 0
        max_duration_ms = 180000  # 3 minutes

        for segment in reversed(segments):  # Start with newest
            duration = segment['duration_ms']
            if total_duration + duration <= max_duration_ms:
                selected.insert(0, segment)  # Insert at beginning to maintain chronological order
                total_duration += duration
            else:
                # Drop oldest segment (FIFO)
                continue

        print(f"DEBUG: Selected {len(selected)} segments for reel (total duration: {total_duration/1000:.1f}s)")

        if not selected:
            print(f"DEBUG: No segments selected after applying 3-min cap")
            return

        # Download selected segments
        segment_files = []
        for segment in selected:
            local_path = os.path.join(self.config['download_dir'], f"seg_{segment['job_id']}.mp4")
            self._download_from_b2(segment['segment_path'])
            # Rename downloaded file to expected name
            downloaded_path = os.path.join(self.config['download_dir'], os.path.basename(segment['segment_path']))
            if os.path.exists(downloaded_path):
                os.rename(downloaded_path, local_path)
                segment_files.append(local_path)
                print(f"DEBUG: Downloaded segment {segment['job_id']} to {local_path}")
            else:
                print(f"DEBUG: Failed to download segment {segment['job_id']}")

        # Create concat file for ffmpeg
        concat_file = os.path.join(self.config['download_dir'], 'concat.txt')
        with open(concat_file, 'w', encoding='utf-8') as f:
            for seg_file in segment_files:
                # Use absolute paths with forward slashes for ffmpeg compatibility on Windows
                abs_path = os.path.abspath(seg_file)
                normalized_path = abs_path.replace('\\', '/')
                f.write(f"file '{normalized_path}'\n")

        print(f"DEBUG: Concat file created at: {concat_file}")
        with open(concat_file, 'r', encoding='utf-8') as f:
            print(f"DEBUG: Concat file contents:\n{f.read()}")

        # Stitch segments using concat filter (more reliable for audio/duration)
        stitched_path = os.path.join(self.config['download_dir'], 'stitched.mp4')
        abs_stitched_path = os.path.abspath(stitched_path)
        stitched_path_normalized = abs_stitched_path.replace('\\', '/')

        # Build input arguments for all segments
        input_args = []
        for seg_file in segment_files:
            abs_seg = os.path.abspath(seg_file)
            normalized_seg = abs_seg.replace('\\', '/')
            input_args.extend(["-i", normalized_seg])

        # Build concat filter
        filter_parts = []
        for i in range(len(segment_files)):
            filter_parts.append(f"[{i}:v][{i}:a]")

        filter_complex = "".join(filter_parts) + f"concat=n={len(segment_files)}:v=1:a=1[outv][outa]"

        print(f"DEBUG: Running ffmpeg with concat filter")
        print(f"DEBUG: Input files: {len(segment_files)}")
        print(f"DEBUG: Filter: {filter_complex}")

        result = subprocess.run(
            [
                "ffmpeg"
            ] + input_args + [
                "-filter_complex", filter_complex,
                "-map", "[outv]",
                "-map", "[outa]",
                "-c:v", "libx264",
                "-c:a", "aac",
                "-strict", "experimental",
                "-y",
                stitched_path_normalized
            ],
            check=True,
            capture_output=True,
            text=True
        )

        print(f"DEBUG: Segments stitched to: {stitched_path}")

        # Add background music with volume ducking
        final_reel_path = self._add_background_music(stitched_path)

        # Upload final reel to B2
        version = self._get_next_reel_version()
        reel_b2_path = f"reels/reel_v{version}.mp4"
        self._upload_segment_to_b2(final_reel_path, reel_b2_path)

        # Record reel version in D1
        response = requests.post(
            f"{self.config['worker_api_url']}/api/reel/version",
            headers={"X-Local-Worker-Key": self.config['local_worker_key']},
            json={
                'version': version,
                'reel_path': reel_b2_path,
                'segment_count': len(selected),
                'total_duration_ms': total_duration
            }
        )
        response.raise_for_status()

        print(f"DEBUG: Reel v{version} uploaded successfully")

        # Cleanup
        for seg_file in segment_files:
            if os.path.exists(seg_file):
                os.remove(seg_file)
        if os.path.exists(concat_file):
            os.remove(concat_file)
        if os.path.exists(stitched_path):
            os.remove(stitched_path)
        if os.path.exists(final_reel_path):
            os.remove(final_reel_path)

    def _add_background_music(self, video_path):
        """Add background music with volume ducking during speech."""
        music_path = self.config.get('background_music_path')
        if not music_path or not os.path.exists(music_path):
            print(f"DEBUG: No background music found, using video without music")
            return video_path

        output_path = os.path.join(self.config['download_dir'], 'reel_with_music.mp4')

        # Normalize paths for Windows
        video_path_normalized = video_path.replace('\\', '/')
        music_path_normalized = music_path.replace('\\', '/')
        output_path_normalized = output_path.replace('\\', '/')

        print(f"DEBUG: Adding background music from: {music_path}")

        # Mix video with background music using sidechain compression for ducking
        # When speech is present (video audio), music volume is reduced
        subprocess.run(
            [
                "ffmpeg",
                "-i", video_path_normalized,
                "-i", music_path_normalized,
                "-filter_complex",
                "[1:a]volume=0.3[music];[0:a][music]sidechaincompress=threshold=0.02:ratio=20:release=0.5:attack=0.01[mixed]",
                "-map", "0:v",
                "-map", "[mixed]",
                "-c:v", "libx264",
                "-c:a", "aac",
                "-strict", "experimental",
                "-shortest",
                "-y",
                output_path_normalized
            ],
            check=True,
            capture_output=True,
            text=True
        )

        print(f"DEBUG: Background music added to: {output_path}")
        return output_path

    def _get_next_reel_version(self):
        """Get the next reel version number from D1."""
        response = requests.get(
            f"{self.config['worker_api_url']}/api/reel/next-version",
            headers={"X-Local-Worker-Key": self.config['local_worker_key']}
        )
        response.raise_for_status()
        return response.json()['version']
