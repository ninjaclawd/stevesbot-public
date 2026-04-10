#!/usr/bin/env python3
"""
Vision-based CAPTCHA solver using RTX 5090 (qwen3-vl)

Flow:
1. Take screenshot of browser/page
2. Send to Ollama vision model on 5090
3. Get CAPTCHA element coordinates
4. Execute HumanMouse click
"""

import argparse
import os
import requests
import json
import base64
import subprocess
import sys
from pathlib import Path

OLLAMA_URL = os.environ.get("CAPTCHA_API_URL", os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434"))
VISION_MODEL = os.environ.get("CAPTCHA_VISION_MODEL", os.environ.get("VISION_MODEL", "qwen3-vl:8b"))

# Resolve captcha_clicker.py relative to this script
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

def encode_image(image_path):
    """Encode image to base64 for Ollama API"""
    with open(image_path, "rb") as f:
        return base64.b64encode(f.read()).decode()

def analyze_screenshot(image_path, api_url=OLLAMA_URL, model=VISION_MODEL):
    """Use vision model to find CAPTCHA coordinates"""

    base64_image = encode_image(image_path)

    prompt = """Analyze this screenshot and find the Cloudflare Turnstile CAPTCHA checkbox or verification element.

Return ONLY a JSON object with the format:
{
  "found": true/false,
  "element_type": "checkbox|button|text|none",
  "center_x": <integer>,
  "center_y": <integer>,
  "confidence": 0.0-1.0,
  "description": "brief description of what you see"
}

The coordinates should be the center point of the CAPTCHA element in screen coordinates (pixels from top-left).
If no CAPTCHA is visible, return found: false."""

    payload = {
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": prompt,
                "images": [base64_image]
            }
        ],
        "stream": False,
        "format": "json"
    }

    try:
        response = requests.post(f"{api_url.rstrip('/')}/api/chat", json=payload, timeout=30)
        response.raise_for_status()

        result = response.json()
        content = result["message"]["content"]

        # Parse JSON response
        coords = json.loads(content)
        return coords

    except Exception as e:
        print(f"Vision analysis error: {e}")
        return None

def click_with_human_mouse(x, y, dry_run=False, verbose=True):
    """Execute click using HumanMouse (captcha_clicker.py in same directory)"""
    if dry_run:
        if verbose:
            print(f"[dry-run] Would click CAPTCHA at ({x}, {y})")
        return True

    clicker = os.path.join(SCRIPT_DIR, "captcha_clicker.py")
    cmd = f"python3 {clicker} {x} {y}"
    print(f"Executing: {cmd}")
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    print(result.stdout)
    if result.stderr:
        print("Error:", result.stderr)
    return result.returncode == 0

def resolve_screenshot_path(path_arg):
    if path_arg:
        return path_arg

    candidates = [
        "/tmp/captcha_vision_test.png",
        "/tmp/captcha_test_result.png",
    ]
    for candidate in candidates:
        if Path(candidate).exists():
            return candidate
    return None

def main():
    parser = argparse.ArgumentParser(description="Vision-based CAPTCHA solver")
    parser.add_argument("--image", "-i", help="Screenshot to analyze")
    parser.add_argument("--dry-run", action="store_true", help="Analyze only; do not click")
    parser.add_argument("--json", action="store_true", help="Output machine-readable JSON only")
    args = parser.parse_args()

    screenshot_path = resolve_screenshot_path(args.image)
    if not screenshot_path:
        message = "No screenshot found. Provide --image or place a screenshot in /tmp/captcha_vision_test.png"
        print(message, file=sys.stderr)
        sys.exit(1)

    if not args.json:
        print("=== Vision-Based CAPTCHA Solver ===\n")
        print(f"Using Ollama at {OLLAMA_URL} with {VISION_MODEL}")
        print(f"\nAnalyzing screenshot: {screenshot_path}")

    result = analyze_screenshot(screenshot_path)
    if not result:
        if args.json:
            print(json.dumps({
                "ok": False,
                "error": "Vision analysis failed",
                "image": screenshot_path,
            }, indent=2))
        else:
            print("Failed to analyze screenshot")
        sys.exit(1)

    payload = {
        "ok": True,
        "image": screenshot_path,
        "dry_run": bool(args.dry_run),
        "analysis": result,
        "clicked": False,
        "click_ready": False,
    }

    if result.get("found") and result.get("confidence", 0) > 0.5:
        x = result["center_x"]
        y = result["center_y"]
        payload["target"] = {"x": x, "y": y}

        clicked = click_with_human_mouse(x, y, dry_run=args.dry_run, verbose=not args.json)
        payload["clicked"] = bool(clicked) and not args.dry_run
        payload["click_ready"] = bool(clicked)

        if not args.json:
            print(f"\nVision model result:")
            print(json.dumps(result, indent=2))
            print(f"\nCAPTCHA found at ({x}, {y})")
            print(f"  Confidence: {result.get('confidence', 'N/A')}")
            print(f"  Description: {result.get('description', 'N/A')}")
            print("\nExecuting HumanMouse click..." if not args.dry_run else "\nDry run only; no click executed.")
            print("Click executed successfully" if clicked else "Click failed")
    else:
        if not args.json:
            print(f"\nVision model result:")
            print(json.dumps(result, indent=2))
            print("\nCAPTCHA not detected in screenshot")
            print(f"  Description: {result.get('description', 'N/A')}")

    if args.json:
        print(json.dumps(payload, indent=2))

if __name__ == "__main__":
    main()
