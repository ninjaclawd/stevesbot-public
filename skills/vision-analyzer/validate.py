#!/usr/bin/env python3
"""
Vision Analyzer - Validated coordinate detection with multiple verification strategies
"""

import argparse
import base64
import json
import requests
import sys
import subprocess
import time
from PIL import Image

OLLAMA_URL = "http://127.0.0.1:11434/api/chat"

def analyze(image_path: str, prompt: str, timeout: int = 30):
    """Analyze image, return (content, elapsed)"""
    with open(image_path, 'rb') as f:
        img_b64 = base64.b64encode(f.read()).decode('utf-8')

    start = time.time()
    response = requests.post(OLLAMA_URL, json={
        'model': 'qwen3-vl:8b',
        'messages': [{'role': 'user', 'content': prompt, 'images': [img_b64]}],
        'stream': False
    }, timeout=timeout)
    elapsed = time.time() - start

    return response.json()['message']['content'], elapsed

def extract_coords(content: str):
    """Extract x,y coordinates from response"""
    try:
        # Try JSON first
        start = content.find('{')
        end = content.rfind('}')
        if start != -1 and end != -1:
            data = json.loads(content[start:end+1])
            # Look for coordinate-like structure
            for key, val in data.items():
                if isinstance(val, dict) and 'x' in val and 'y' in val:
                    return val['x'], val['y']
                if key in ['x', 'y']:
                    return data.get('x'), data.get('y')
    except:
        pass

    # Try text parsing for "x: 123, y: 456" pattern
    import re
    matches = re.findall(r'[\("\']?(\d+)[\)"\']?,?\s*[\("\']?(\d+)[\)"\']?', content)
    if matches:
        return int(matches[0][0]), int(matches[0][1])

    return None, None

def mark_image(image_path: str, x: int, y: int, output_path: str):
    """Mark coordinates on image for verification"""
    from PIL import ImageDraw
    with Image.open(image_path) as img:
        draw = ImageDraw.Draw(img)
        # Red crosshair
        draw.ellipse([x-10, y-10, x+10, y+10], outline='red', width=3)
        draw.line([x-15, y, x+15, y], fill='red', width=2)
        draw.line([x, y-15, x, y+15], fill='red', width=2)
        img.save(output_path)
    return output_path

def validate_detection(image_path: str, element_description: str):
    """
    Multi-step validation:
    1. Detect coordinates
    2. Mark on image
    3. Verify with vision what was marked
    4. Cross-check with simpler prompt
    """
    print(f"=== Validating detection for: {element_description} ===\n")

    # Step 1: Detect coordinates
    print("Step 1: Detecting coordinates...")
    prompt = f"Find the center of the {element_description}. Return ONLY JSON: {{\"x\": number, \"y\": number}}"
    content, elapsed = analyze(image_path, prompt)
    x, y = extract_coords(content)
    print(f"  Detected: ({x}, {y}) in {elapsed:.2f}s")

    if x is None or y is None:
        print("  Failed to extract coordinates")
        return None

    # Step 2: Mark on image
    print("\nStep 2: Marking coordinates...")
    marked_path = image_path.replace('.png', '_marked.png')
    mark_image(image_path, x, y, marked_path)
    print(f"  Saved: {marked_path}")

    # Step 3: Verify what was marked
    print("\nStep 3: Verifying marked location...")
    verify_prompt = "There is a red crosshair in this image. What UI element is it pointing at? Answer in 5 words or less."
    verify_content, _ = analyze(marked_path, verify_prompt)
    print(f"  Vision says: '{verify_content}'")

    # Check if verification matches expectation
    element_keywords = element_description.lower().split()
    match_score = sum(1 for kw in element_keywords if kw in verify_content.lower())
    confidence = match_score / len(element_keywords) if element_keywords else 0

    print(f"  Confidence: {confidence:.0%}")

    # Step 4: Cross-check with simpler prompt
    print("\nStep 4: Cross-checking...")
    simple_prompt = f"Is there a {element_description} in this image? Answer yes or no only."
    simple_content, _ = analyze(image_path, simple_prompt)
    print(f"  Exists: {simple_content.strip()}")

    # Result
    print("\n=== Validation Result ===")
    if confidence >= 0.5 or 'yes' in simple_content.lower():
        print(f"Coordinates ({x}, {y}) appear valid")
        print(f"   Pointing at: {verify_content}")
        return {'x': x, 'y': y, 'confidence': confidence, 'element': verify_content}
    else:
        print(f"Coordinates may be incorrect")
        print(f"   Expected: {element_description}")
        print(f"   Found: {verify_content}")
        return None

def main():
    parser = argparse.ArgumentParser(description='Validated vision detection')
    parser.add_argument('element', help='Element to find (e.g., "Next button")')
    parser.add_argument('--image', '-i', default='/tmp/test_full.png',
                        help='Image to analyze')

    args = parser.parse_args()

    result = validate_detection(args.image, args.element)
    if result:
        print(f"\nFinal coordinates: ({result['x']}, {result['y']})")
    else:
        sys.exit(1)

if __name__ == "__main__":
    main()
