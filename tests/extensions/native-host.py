#!/usr/bin/env python3
"""A native messaging host for the self-test: answers every message with what it received."""
import json
import struct
import sys

while True:
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        break
    (length,) = struct.unpack("<I", raw)
    message = json.loads(sys.stdin.buffer.read(length))
    reply = json.dumps({"echo": message, "argv": sys.argv[1:]}).encode()
    sys.stdout.buffer.write(struct.pack("<I", len(reply)) + reply)
    sys.stdout.buffer.flush()
