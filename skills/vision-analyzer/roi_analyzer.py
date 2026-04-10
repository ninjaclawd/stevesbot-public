#!/usr/bin/env python3
"""
Focused ROI (Region of Interest) Analyzer

Crops to a specific region before analysis for:
- Faster inference (smaller image)
- More precise coordinates
- Automatic offset tracking

Usage:
    python3 roi_analyzer.py --image screenshot.png --roi 400,500,300,200 --prompt "Find the submit button"

    # ROI format: x,y,width,height
    # Returns coordinates adjusted for original image
"""

import argparse
import base64
import json
import requests
import sys
from PIL import Image
import io
import re

OLLAMA_URL = "http://127.0.0.1:11434/api/chat"
VISION_MODEL = "qwen3.5:35b"

def crop_image(image_path: str, x: int, y: int, w: int, h: int) -> tuple:
    """Crop image to ROI, return (cropped_bytes, original_size, crop_offset)"""
    with Image.open(image_path) as img:
        original_size = img.size

        # Ensure crop bounds are within image
        x = max(0, min(x, img.width - 1))
        y = max(0, min(y, img.height - 1))
        w = min(w, img.width - x)
        h = min(h, img.height - y)

        cropped = img.crop((x, y, x + w, y + h))

        # Convert to JPEG for smaller size
        if cropped.mode == 'RGBA':
            cropped = cropped.convert('RGB')

        buffer = io.BytesIO()
        cropped.save(buffer, format='JPEG', quality=85)

        return buffer.getvalue(), original_size, (x, y, w, h)

def analyze_roi(image_bytes: bytes, prompt: str, timeout: int = 120) -> dict:
    """Analyze cropped ROI with vision model"""
    img_b64 = base64.b64encode(image_bytes).decode('utf-8')

    response = requests.post(OLLAMA_URL, json={
        'model': VISION_MODEL,
        'messages': [{
            'role': 'user',
            'content': prompt,
            'images': [img_b64]
        }],
        'stream': False,
        'options': {'num_ctx': 2048}
    }, timeout=timeout)

    response.raise_for_status()
    return response.json()

def extract_coordinates(text: str) -> list:
    """Extract coordinate pairs from response text"""
    coords = []

    # Try JSON format first
    try:
        json_match = re.search(r'\{[^}]+\}|\[[^\]]+\]', text)
        if json_match:
            data = json.loads(json_match.group())
            if isinstance(data, dict):
                for key, val in data.items():
                    if isinstance(val, (list, tuple)) and len(val) == 2:
                        coords.append({'label': key, 'x': val[0], 'y': val[1]})
                    elif isinstance(val, dict) and 'x' in val and 'y' in val:
                        coords.append({'label': key, 'x': val['x'], 'y': val['y']})
            elif isinstance(data, list):
                for item in data:
                    if isinstance(item, dict) and 'x' in item and 'y' in item:
                        coords.append(item)
    except:
        pass

    # Fallback: regex for x,y patterns
    if not coords:
        patterns = re.findall(r'(\d+)\s*,\s*(\d+)', text)
        for x, y in patterns:
            coords.append({'x': int(x), 'y': int(y)})

    return coords

def adjust_coordinates(coords: list, crop_offset: tuple) -> list:
    """Adjust coordinates to original image space"""
    ox, oy, _, _ = crop_offset
    adjusted = []
    for c in coords:
        adj = c.copy()
        adj['x'] = c['x'] + ox
        adj['y'] = c['y'] + oy
        adj['original_x'] = c['x']
        adj['original_y'] = c['y']
        adjusted.append(adj)
    return adjusted

def main():
    parser = argparse.ArgumentParser(description='Analyze ROI with vision model')
    parser.add_argument('--image', '-i', required=True, help='Path to screenshot')
    parser.add_argument('--roi', '-r', required=True, help='ROI as x,y,w,h')
    parser.add_argument('--prompt', '-p', required=True, help='Analysis prompt')
    parser.add_argument('--timeout', '-t', type=int, default=120, help='Timeout seconds')
    parser.add_argument('--raw', action='store_true', help='Show raw response only')

    args = parser.parse_args()

    # Parse ROI
    try:
        x, y, w, h = map(int, args.roi.split(','))
    except:
        print("Error: ROI must be x,y,w,h (e.g., 400,500,300,200)", file=sys.stderr)
        sys.exit(1)

    try:
        # Crop image
        img_bytes, original_size, crop_offset = crop_image(args.image, x, y, w, h)

        print(f"Original image: {original_size[0]}x{original_size[1]}", file=sys.stderr)
        print(f"ROI: x={crop_offset[0]}, y={crop_offset[1]}, w={crop_offset[2]}, h={crop_offset[3]}", file=sys.stderr)
        print(f"Cropped size: {len(img_bytes)} bytes", file=sys.stderr)

        # Analyze
        result = analyze_roi(img_bytes, args.prompt, args.timeout)
        content = result.get('message', {}).get('content', '')

        if args.raw:
            print(content)
            return

        # Extract and adjust coordinates
        coords = extract_coordinates(content)
        adjusted = adjust_coordinates(coords, crop_offset)

        output = {
            'raw_response': content,
            'crop_offset': {'x': crop_offset[0], 'y': crop_offset[1]},
            'coordinates_in_roi': coords,
            'coordinates_in_original': adjusted
        }

        print(json.dumps(output, indent=2))

    except requests.exceptions.Timeout:
        print("Error: Vision request timed out", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
