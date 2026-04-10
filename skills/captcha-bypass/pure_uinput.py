#!/usr/bin/env python3
"""
Pure System-Level Form Automation
Uses ONLY uinput (no CDP, no browser automation)
"""

import subprocess
import time
import random
from evdev import UInput, ecodes as e

# Key mapping
KEY_MAP = {
    'a': e.KEY_A, 'b': e.KEY_B, 'c': e.KEY_C, 'd': e.KEY_D, 'e': e.KEY_E,
    'f': e.KEY_F, 'g': e.KEY_G, 'h': e.KEY_H, 'i': e.KEY_I, 'j': e.KEY_J,
    'k': e.KEY_K, 'l': e.KEY_L, 'm': e.KEY_M, 'n': e.KEY_N, 'o': e.KEY_O,
    'p': e.KEY_P, 'q': e.KEY_Q, 'r': e.KEY_R, 's': e.KEY_S, 't': e.KEY_T,
    'u': e.KEY_U, 'v': e.KEY_V, 'w': e.KEY_W, 'x': e.KEY_X, 'y': e.KEY_Y,
    'z': e.KEY_Z, '0': e.KEY_0, '1': e.KEY_1, '2': e.KEY_2, '3': e.KEY_3,
    '4': e.KEY_4, '5': e.KEY_5, '6': e.KEY_6, '7': e.KEY_7, '8': e.KEY_8,
    '9': e.KEY_9, '@': e.KEY_2, '.': e.KEY_DOT, '-': e.KEY_MINUS,
    '_': e.KEY_MINUS, '!': e.KEY_1, ' ': e.KEY_SPACE
}

class HumanInput:
    """Human-like input using uinput"""

    def __init__(self):
        # Mouse capabilities
        self.mouse_caps = {
            e.EV_REL: [e.REL_X, e.REL_Y],
            e.EV_ABS: [e.ABS_X, e.ABS_Y],
            e.EV_KEY: [e.BTN_LEFT, e.BTN_RIGHT, e.BTN_MIDDLE],
        }
        self.mouse_abs = {
            e.ABS_X: (0, 1920, 0, 0, 0),
            e.ABS_Y: (0, 1080, 0, 0, 0),
        }

        # Keyboard capabilities
        self.key_caps = {
            e.EV_KEY: [e.KEY_LEFTCTRL, e.KEY_LEFTSHIFT, e.KEY_A] + list(KEY_MAP.values())
        }

        self.current_x = 960
        self.current_y = 540

    def _delay(self, base_ms=50, variance_ms=30):
        delay = base_ms + random.randint(-variance_ms, variance_ms)
        return max(10, delay) / 1000.0

    def click(self, x, y):
        """Move and click using uinput"""
        ui = UInput(self.mouse_caps, name="human-mouse", phys="human-mouse")

        print(f"Moving to ({x}, {y})")
        dx = x - self.current_x
        dy = y - self.current_y

        steps = max(abs(dx), abs(dy)) // 10
        if steps < 10:
            steps = 10

        for i in range(steps):
            step_x = int(self.current_x + (dx * i / steps))
            step_y = int(self.current_y + (dy * i / steps))
            rel_x = step_x - self.current_x if i == 0 else int(dx / steps)
            rel_y = step_y - self.current_y if i == 0 else int(dy / steps)

            ui.write(e.EV_REL, e.REL_X, rel_x)
            ui.write(e.EV_REL, e.REL_Y, rel_y)
            ui.syn()
            time.sleep(self._delay(8, 5))

        self.current_x = x
        self.current_y = y

        # Click
        time.sleep(0.1)
        ui.write(e.EV_KEY, e.BTN_LEFT, 1)
        ui.syn()
        time.sleep(self._delay(80, 40))
        ui.write(e.EV_KEY, e.BTN_LEFT, 0)
        ui.syn()
        time.sleep(0.1)

        ui.close()

    def type_text(self, text):
        """Type text using uinput with human-like delays"""
        ui = UInput(self.key_caps, name="human-keyboard")

        # Select all first (Ctrl+A)
        time.sleep(0.2)
        ui.write(e.EV_KEY, e.KEY_LEFTCTRL, 1)
        ui.syn()
        time.sleep(0.05)
        ui.write(e.EV_KEY, e.KEY_A, 1)
        ui.syn()
        time.sleep(0.05)
        ui.write(e.EV_KEY, e.KEY_A, 0)
        ui.syn()
        time.sleep(0.05)
        ui.write(e.EV_KEY, e.KEY_LEFTCTRL, 0)
        ui.syn()
        time.sleep(0.1)

        # Type each character
        for char in text.lower():
            time.sleep(self._delay(50, 30))

            if char in ['@', '_', '!']:
                ui.write(e.EV_KEY, e.KEY_LEFTSHIFT, 1)
                ui.syn()
                time.sleep(0.01)

            key = KEY_MAP.get(char, e.KEY_SPACE)
            ui.write(e.EV_KEY, key, 1)
            ui.syn()
            time.sleep(self._delay(20, 10))
            ui.write(e.EV_KEY, key, 0)
            ui.syn()

            if char in ['@', '_', '!']:
                ui.write(e.EV_KEY, e.KEY_LEFTSHIFT, 0)
                ui.syn()

        ui.close()
        print(f"Typed: {text}")

if __name__ == "__main__":
    import datetime

    ui = HumanInput()

    email = f"bot{int(datetime.datetime.now().timestamp())}@example.com"
    password = "SecurePass123!"

    print(f"Testing with email: {email}")
    print("=" * 50)

    print("\n1. Clicking email field...")
    ui.click(500, 400)
    time.sleep(0.3)

    print("\n2. Typing email...")
    ui.type_text(email)
    time.sleep(0.5)

    print("\n3. Clicking password field...")
    ui.click(500, 480)
    time.sleep(0.3)

    print("\n4. Typing password...")
    ui.type_text(password)
    time.sleep(0.5)

    print("\nForm filled using pure uinput (no CDP)")
    print(f"\nEmail used: {email}")
