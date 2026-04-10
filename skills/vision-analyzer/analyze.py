#!/usr/bin/env python3
"""
Vision Analyzer - LM Studio / OpenAI-compatible endpoint
Usage: analyze.py "prompt" [--image path] [--format json|text] [--verify] [--crop x,y,w,h]
"""

import argparse
import base64
import json
import requests
import sys
import subprocess
import time
from PIL import Image
import io
import os

# OpenAI-compatible endpoint (works with LM Studio, llama-server, Ollama)
API_URL = os.environ.get("VISION_API_URL", "http://127.0.0.1:11434/v1/chat/completions")
VISION_MODEL = os.environ.get("VISION_MODEL", "local-qwen-fallback")  # Q6_K_XL with thinking enabled

def take_screenshot(output_path: str = "/tmp/vision_test.png"):
    """Take screenshot using scrot"""
    subprocess.run([f'DISPLAY=:0 scrot -o {output_path}'], shell=True, check=True)
    return output_path

def crop_image(image_path: str, x: int, y: int, w: int, h: int, output_path: str = None):
    """Crop image to region of interest"""
    if output_path is None:
        output_path = image_path.replace('.png', '_cropped.png')

    with Image.open(image_path) as img:
        cropped = img.crop((x, y, x + w, y + h))
        cropped.save(output_path)

    return output_path

def encode_image(image_path: str) -> str:
    """Encode image to base64"""
    with open(image_path, 'rb') as f:
        return base64.b64encode(f.read()).decode('utf-8')

def analyze_image(image_path: str, prompt: str, model: str = None, timeout: int = 120):
    """Analyze image with vision model using OpenAI-compatible format"""

    if model is None:
        model = VISION_MODEL

    img_b64 = encode_image(image_path)

    start = time.time()
    response = requests.post(API_URL, json={
        'model': model,
        'messages': [{
            'role': 'user',
            'content': [
                {'type': 'text', 'text': prompt},
                {'type': 'image_url', 'image_url': {'url': f'data:image/png;base64,{img_b64}'}}
            ]
        }],
        'max_tokens': 500,
        'stream': False
    }, timeout=timeout)
    elapsed = time.time() - start

    response.raise_for_status()
    result = response.json()
    message = result['choices'][0]['message']

    # Handle thinking models - prefer content, fallback to reasoning_content
    content = message.get('content', '')
    reasoning = message.get('reasoning_content', '')

    # If content is empty but reasoning exists, use reasoning
    if not content.strip() and reasoning:
        content = reasoning

    return content, elapsed, reasoning

def extract_json(content: str):
    """Extract JSON from response text"""
    try:
        start = content.find('{')
        end = content.rfind('}')
        if start != -1 and end != -1:
            json_str = content[start:end+1]
            return json.loads(json_str)
    except:
        pass
    return None

def batch_analyze(image_path: str, prompt: str, models: list = None):
    """Analyze with multiple models for cross-verification"""
    if models is None:
        models = [VISION_MODEL]

    results = []
    for model in models:
        try:
            content, elapsed, reasoning = analyze_image(image_path, prompt, model)
            results.append({
                'model': model,
                'content': content,
                'reasoning': reasoning,
                'elapsed': elapsed,
                'json': extract_json(content)
            })
        except Exception as e:
            results.append({
                'model': model,
                'error': str(e)
            })

    return results

def verify_coordinates(x: int, y: int, pre_click_image: str = None,
                       post_click_image: str = None, check_change: bool = True):
    """Verify coordinates by clicking and checking for change"""

    # Take pre-click screenshot if not provided
    if pre_click_image is None:
        pre_click_image = "/tmp/verify_pre.png"
        take_screenshot(pre_click_image)

    # Click at coordinates using xdotool (more reliable for browser)
    subprocess.run([f'DISPLAY=:0 xdotool mousemove {x} {y} click 1'], shell=True, check=True)
    time.sleep(0.5)

    # Take post-click screenshot
    if post_click_image is None:
        post_click_image = "/tmp/verify_post.png"
    take_screenshot(post_click_image)

    if not check_change:
        return {'clicked': True, 'pre': pre_click_image, 'post': post_click_image}

    # Analyze if something changed
    try:
        content_pre, _, _ = analyze_image(pre_click_image,
            "Describe the main interactive element at the center of the image in 5 words or less")
        content_post, _, _ = analyze_image(post_click_image,
            "Describe the main interactive element at the center of the image in 5 words or less")

        changed = content_pre.strip() != content_post.strip()

        return {
            'clicked': True,
            'changed': changed,
            'pre_description': content_pre,
            'post_description': content_post,
            'pre_image': pre_click_image,
            'post_image': post_click_image
        }
    except Exception as e:
        return {
            'clicked': True,
            'error': str(e),
            'pre_image': pre_click_image,
            'post_image': post_click_image
        }

def main():
    parser = argparse.ArgumentParser(description='Analyze images with vision model')
    parser.add_argument('prompt', help='What to ask about the image')
    parser.add_argument('--image', '-i', default='/tmp/vision_test.png',
                        help='Path to image file')
    parser.add_argument('--format', '-f', choices=['text', 'json'], default='text',
                        help='Output format')
    parser.add_argument('--screenshot', '-s', action='store_true',
                        help='Take screenshot first')
    parser.add_argument('--crop', '-c',
                        help='Crop to region: x,y,w,h')
    parser.add_argument('--verify', '-v', action='store_true',
                        help='Verify coordinates by clicking (use with --coords)')
    parser.add_argument('--coords',
                        help='Coordinates to verify: x,y')
    parser.add_argument('--batch', '-b', action='store_true',
                        help='Batch analyze with multiple models')
    parser.add_argument('--timing', '-t', action='store_true',
                        help='Show timing information')
    parser.add_argument('--reasoning', '-r', action='store_true',
                        help='Show reasoning content (thinking models)')

    args = parser.parse_args()

    try:
        # Take screenshot if requested
        if args.screenshot:
            take_screenshot(args.image)

        # Crop if requested
        image_path = args.image
        crop_offset = (0, 0)
        if args.crop:
            parts = args.crop.split(',')
            x, y, w, h = int(parts[0]), int(parts[1]), int(parts[2]), int(parts[3])
            image_path = crop_image(args.image, x, y, w, h)
            crop_offset = (x, y)

        # Verify coordinates if requested
        if args.verify and args.coords:
            parts = args.coords.split(',')
            x, y = int(parts[0]), int(parts[1])

            # Adjust for crop offset
            x += crop_offset[0]
            y += crop_offset[1]

            result = verify_coordinates(x, y)
            print(json.dumps(result, indent=2))
            return

        # Batch analysis
        if args.batch:
            results = batch_analyze(image_path, args.prompt)
            output = {
                'prompt': args.prompt,
                'image': image_path,
                'results': results
            }
            print(json.dumps(output, indent=2))
            return

        # Single analysis
        content, elapsed, reasoning = analyze_image(image_path, args.prompt)

        # Format output
        if args.format == "json":
            parsed = extract_json(content)
            if parsed:
                # Adjust coordinates for crop offset if needed
                if crop_offset != (0, 0) and isinstance(parsed, dict):
                    for key, value in parsed.items():
                        if isinstance(value, dict) and 'x' in value and 'y' in value:
                            value['x'] += crop_offset[0]
                            value['y'] += crop_offset[1]
                print(json.dumps(parsed, indent=2))
            else:
                output = {"raw_response": content, "elapsed_sec": elapsed}
                if args.reasoning:
                    output['reasoning'] = reasoning
                print(json.dumps(output, indent=2))
        else:
            print(content)
            if args.reasoning and reasoning:
                print(f"\n[Thinking: {reasoning[:200]}...]", file=sys.stderr)

        if args.timing:
            print(f"\n[Time: {elapsed:.2f}s]", file=sys.stderr)

    except requests.exceptions.Timeout:
        print("Error: Vision request timed out. Try a simpler prompt or crop the image.", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
