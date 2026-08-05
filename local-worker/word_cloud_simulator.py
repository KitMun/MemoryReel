#!/usr/bin/env python3
"""
Word Cloud Simulator
Simulates real-time updates to the word cloud table for testing the visual effect.
"""

import requests
import time
import random
import json
from datetime import datetime

# Configuration
WORKER_API_URL = "https://memory-reel.muntheexplorer.workers.dev/api/word-cloud/update"  # Update with your Worker URL
LOCAL_WORKER_KEY = "mmrWorkerKey"  # Update with your actual key

# Base phrases from dev.sql
BASE_PHRASES = [
    '新婚快乐', '百年好合', '永结同心', '白头偕老',
    '早生贵子', '幸福美满', '天作之合', '佳偶天成', '花好月圆',
    '相亲相爱', '恩爱永恒', '鸾凤和鸣', '琴瑟和鸣', '情比金坚',
    '甜甜蜜蜜', '携手一生', '心心相印', '相濡以沫', '执子之手',
    '与子偕老', '爱情长久', '喜结良缘', '龙凤呈祥', '阿顾',
    '吉祥如意', '幸福久久', '美满人生', '恩恩爱爱', '同心同行',
    '比翼双飞', '咏萱', '良缘永结', '花开并蒂', '喜气洋洋',
    '情深意浓', '爱意绵长', '幸福同行', '家庭美满', '相守一生'
]

# Additional phrases to simulate new blessings
NEW_PHRASES = [
    '恭喜恭喜', '大吉大利', '万事如意', '心想事成', '步步高升',
    '前程似锦', '财源广进', '身体健康', '工作顺利', '学业有成',
    '生意兴隆', '合家欢乐', '平安喜乐', '福星高照', '吉星高照'
]

def update_word_cloud(phrases):
    """Send phrases to the Worker API to update word cloud."""
    try:
        response = requests.post(
            WORKER_API_URL,
            headers={"X-Local-Worker-Key": LOCAL_WORKER_KEY},
            json={'phrases': phrases}
        )
        response.raise_for_status()
        print(f"[{datetime.now().strftime('%H:%M:%S')}] Updated {len(phrases)} phrases: {phrases}")
        return True
    except Exception as e:
        print(f"[{datetime.now().strftime('%H:%M:%S')}] Error updating word cloud: {e}")
        return False

def simulate_incremental_updates():
    """Simulate incremental updates to existing phrases."""
    print("Starting incremental updates simulation...")
    print("Press Ctrl+C to stop\n")

    try:
        while True:
            # Randomly select 1-3 phrases to increment
            num_phrases = random.randint(1, 3)
            selected_phrases = random.sample(BASE_PHRASES, num_phrases)
            update_word_cloud(selected_phrases)

            # Random delay between 2-8 seconds
            delay = random.uniform(2, 8)
            time.sleep(delay)

    except KeyboardInterrupt:
        print("\nSimulation stopped by user")

def simulate_new_phrases():
    """Simulate adding new phrases occasionally."""
    print("Starting new phrases simulation...")
    print("Press Ctrl+C to stop\n")

    try:
        while True:
            # Randomly decide whether to add new phrases (30% chance)
            if random.random() < 0.3:
                num_new = random.randint(1, 2)
                new_phrases = random.sample(NEW_PHRASES, num_new)
                update_word_cloud(new_phrases)

            # Also increment some existing phrases
            num_existing = random.randint(1, 2)
            existing_phrases = random.sample(BASE_PHRASES, num_existing)
            update_word_cloud(existing_phrases)

            # Random delay between 3-10 seconds
            delay = random.uniform(3, 10)
            time.sleep(delay)

    except KeyboardInterrupt:
        print("\nSimulation stopped by user")

def simulate_burst_mode():
    """Simulate burst mode for testing rapid updates."""
    print("Starting burst mode simulation...")
    print("Press Ctrl+C to stop\n")

    try:
        burst_count = 0
        while True:
            # Every 10 updates, do a burst of 5 phrases
            if burst_count % 10 == 0:
                phrases = random.sample(BASE_PHRASES, 5)
                update_word_cloud(phrases)
                burst_count += 1
                time.sleep(0.5)
            else:
                phrases = random.sample(BASE_PHRASES, 1)
                update_word_cloud(phrases)
                burst_count += 1
                time.sleep(random.uniform(1, 3))

    except KeyboardInterrupt:
        print("\nSimulation stopped by user")

if __name__ == "__main__":
    import sys

    print("Word Cloud Simulator")
    print("=" * 50)
    print("\nChoose simulation mode:")
    print("1. Incremental updates (existing phrases only)")
    print("2. New phrases (occasionally add new phrases)")
    print("3. Burst mode (rapid updates for testing)")
    print("\nUsage: python word_cloud_simulator.py <mode>")
    print("Example: python word_cloud_simulator.py 1")

    if len(sys.argv) < 2:
        print("\nNo mode specified, using default: incremental updates")
        mode = "1"
    else:
        mode = sys.argv[1]

    print(f"\nStarting mode {mode}...\n")

    if mode == "1":
        simulate_incremental_updates()
    elif mode == "2":
        simulate_new_phrases()
    elif mode == "3":
        simulate_burst_mode()
    else:
        print(f"Invalid mode: {mode}")
        sys.exit(1)
