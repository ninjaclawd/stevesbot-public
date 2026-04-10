#!/usr/bin/env python3
"""
Human-like keyboard input via uinput

Usage:
    python human_typer.py "text to type"
    python human_typer.py  # generates random email
"""

import time
import random
from evdev import UInput, ecodes as e

# Key mapping for common characters
KEY_MAP = {
    'a': e.KEY_A, 'b': e.KEY_B, 'c': e.KEY_C, 'd': e.KEY_D, 'e': e.KEY_E,
    'f': e.KEY_F, 'g': e.KEY_G, 'h': e.KEY_H, 'i': e.KEY_I, 'j': e.KEY_J,
    'k': e.KEY_K, 'l': e.KEY_L, 'm': e.KEY_M, 'n': e.KEY_N, 'o': e.KEY_O,
    'p': e.KEY_P, 'q': e.KEY_Q, 'r': e.KEY_R, 's': e.KEY_S, 't': e.KEY_T,
    'u': e.KEY_U, 'v': e.KEY_V, 'w': e.KEY_W, 'x': e.KEY_X, 'y': e.KEY_Y,
    'z': e.KEY_Z, '0': e.KEY_0, '1': e.KEY_1, '2': e.KEY_2, '3': e.KEY_3,
    '4': e.KEY_4, '5': e.KEY_5, '6': e.KEY_6, '7': e.KEY_7, '8': e.KEY_8,
    '9': e.KEY_9, '@': e.KEY_2, '.': e.KEY_DOT, '-': e.KEY_MINUS,
    '_': e.KEY_MINUS, ' ': e.KEY_SPACE
}

def type_text(text, select_all_first=True):
    caps = {e.EV_KEY: [e.KEY_LEFTCTRL, e.KEY_LEFTSHIFT, e.KEY_A] + list(KEY_MAP.values())}
    ui = UInput(caps, name="human-typer")

    # Select all first (Ctrl+A)
    if select_all_first:
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

    for char in text.lower():
        if char in KEY_MAP:
            # Random delay 50-150ms per character
            time.sleep(random.randint(50, 150) / 1000.0)

            if char == '@' or char == '_':
                # Need shift for @ and _
                ui.write(e.EV_KEY, e.KEY_LEFTSHIFT, 1)
                ui.syn()
                time.sleep(0.01)

            key = KEY_MAP[char]
            ui.write(e.EV_KEY, key, 1)
            ui.syn()
            time.sleep(random.randint(20, 50) / 1000.0)
            ui.write(e.EV_KEY, key, 0)
            ui.syn()

            if char == '@' or char == '_':
                ui.write(e.EV_KEY, e.KEY_LEFTSHIFT, 0)
                ui.syn()

    ui.close()
    print(f"Typed: {text}")

if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1:
        type_text(sys.argv[1])
    else:
        # Generate random email
        import datetime
        email = f"bot{int(datetime.datetime.now().timestamp())}@example.com"
        type_text(email)
