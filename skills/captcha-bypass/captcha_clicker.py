#!/usr/bin/env python3
"""
Cloudflare CAPTCHA clicker using uinput for undetectable input simulation

Usage:
    python captcha_clicker.py <x> <y> [--drag <end_x> <end_y>]
    python captcha_clicker.py --path <start_x> <start_y> <end_x> <end_y>
"""

import sys
import time
import random
import argparse
from evdev import UInput, ecodes as e

class HumanMouse:
    """Simulate human-like mouse input with realistic timing"""

    def __init__(self, name="py-evdev-uinput"):
        self.capabilities = {
            e.EV_REL: [e.REL_X, e.REL_Y],
            e.EV_ABS: [e.ABS_X, e.ABS_Y],
            e.EV_KEY: [e.BTN_LEFT, e.BTN_RIGHT, e.BTN_MIDDLE],
        }

        self.absinfo = {
            e.ABS_X: (0, 1920, 0, 0, 0),
            e.ABS_Y: (0, 1080, 0, 0, 0),
        }

        self.device = UInput(self.capabilities, name=name, phys=name)
        self.current_x = 960  # Center of 1920
        self.current_y = 540  # Center of 1080

    def close(self):
        """Clean up virtual device"""
        self.device.close()

    def _delay(self, base_ms=50, variance_ms=30):
        """Human-like random delay"""
        delay = base_ms + random.randint(-variance_ms, variance_ms)
        delay = max(10, delay)
        return delay / 1000.0

    def _bezier_point(self, p0, p1, p2, p3, t):
        """Calculate point on cubic bezier curve"""
        mt = 1 - t
        x = (mt**3 * p0[0] + 3 * mt**2 * t * p1[0] + 3 * mt * t**2 * p2[0] + t**3 * p3[0])
        y = (mt**3 * p0[1] + 3 * mt**2 * t * p1[1] + 3 * mt * t**2 * p2[1] + t**3 * p3[1])
        return int(x), int(y)

    def _generate_path(self, start_x, start_y, end_x, end_y, steps=25):
        """Generate natural-looking mouse path"""
        mid_x = (start_x + end_x) / 2
        mid_y = (start_y + end_y) / 2

        offset_x = random.randint(-50, 50)
        offset_y = random.randint(-50, 50)

        p0 = (start_x, start_y)
        p1 = (mid_x + offset_x, mid_y + offset_y)
        p2 = (mid_x - offset_x, mid_y - offset_y)
        p3 = (end_x, end_y)

        path = []
        for i in range(steps + 1):
            t = i / steps
            point = self._bezier_point(p0, p1, p2, p3, t)
            path.append(point)

        return path

    def move_to(self, x, y):
        """Move mouse to position with natural movement"""
        print(f"Moving mouse from ({self.current_x}, {self.current_y}) to ({x}, {y})")

        path = self._generate_path(self.current_x, self.current_y, x, y)

        prev_x, prev_y = self.current_x, self.current_y
        for px, py in path:
            dx = px - prev_x
            dy = py - prev_y

            self.device.write(e.EV_REL, e.REL_X, dx)
            self.device.write(e.EV_REL, e.REL_Y, dy)
            self.device.syn()

            prev_x, prev_y = (px, py)
            time.sleep(self._delay(8, 5))

        self.current_x, self.current_y = x, y

    def click(self, button=e.BTN_LEFT, double=False):
        """Click mouse button with natural timing"""
        print(f"Clicking (button={button}, double={double})")

        self.device.write(e.EV_KEY, button, 1)
        self.device.syn()
        time.sleep(self._delay(80, 40))

        self.device.write(e.EV_KEY, button, 0)
        self.device.syn()

        if double:
            time.sleep(self._delay(60, 30))
            self.device.write(e.EV_KEY, button, 1)
            self.device.syn()
            time.sleep(self._delay(80, 40))
            self.device.write(e.EV_KEY, button, 0)
            self.device.syn()

        time.sleep(self._delay(100, 50))

    def click_at(self, x, y):
        """Move to position and click"""
        self.move_to(x, y)
        self.click()

    def drag(self, start_x, start_y, end_x, end_y):
        """Drag from one position to another"""
        self.move_to(start_x, start_y)

        self.device.write(e.EV_KEY, e.BTN_LEFT, 1)
        self.device.syn()
        time.sleep(self._delay(50, 20))

        path = self._generate_path(start_x, start_y, end_x, end_y, steps=30)

        prev_x, prev_y = start_x, start_y
        for px, py in path:
            dx = px - prev_x
            dy = py - prev_y
            self.device.write(e.EV_REL, e.REL_X, dx)
            self.device.write(e.EV_REL, e.REL_Y, dy)
            self.device.syn()
            prev_x, prev_y = (px, py)
            time.sleep(self._delay(8, 5))

        self.current_x, self.current_y = end_x, end_y

        self.device.write(e.EV_KEY, e.BTN_LEFT, 0)
        self.device.syn()
        time.sleep(self._delay(100, 50))

def main():
    parser = argparse.ArgumentParser(description="Human-like mouse input via uinput")
    parser.add_argument("x", type=int, nargs="?", help="X coordinate")
    parser.add_argument("y", type=int, nargs="?", help="Y coordinate")
    parser.add_argument("--drag", nargs=2, type=int, metavar=("END_X", "END_Y"), help="Drag to position")
    parser.add_argument("--path", nargs=4, type=int, metavar=("START_X", "START_Y", "END_X", "END_Y"), help="Draw path from start to end")
    parser.add_argument("--double", action="store_true", help="Double click")
    parser.add_argument("--test", action="store_true", help="Run test pattern")

    args = parser.parse_args()

    mouse = HumanMouse()

    try:
        if args.test:
            print("Running test pattern...")
            for i in range(5):
                x = random.randint(200, 1700)
                y = random.randint(200, 880)
                mouse.click_at(x, y)
                time.sleep(random.uniform(0.3, 0.8))

        elif args.path:
            print(f"Drawing path from ({args.path[0]}, {args.path[1]}) to ({args.path[2]}, {args.path[3]})")
            mouse.drag(args.path[0], args.path[1], args.path[2], args.path[3])

        elif args.drag:
            print(f"Dragging to ({args.drag[0]}, {args.drag[1]})")
            mouse.drag(args.x, args.y, args.drag[0], args.drag[1])

        elif args.x is not None and args.y is not None:
            mouse.click_at(args.x, args.y)

        else:
            parser.print_help()

    finally:
        mouse.close()

if __name__ == "__main__":
    main()
