#!/usr/bin/env python3
"""A DNS server that answers NXDOMAIN to everything and logs every name it is asked for.

Runs inside the measurement network namespace, where nothing can reach the real network, so it is
the only place a DNS question can go. Usage: dns-sink.py <logfile>
"""
import socket
import socketserver
import struct
import sys
import threading
import time

LOG = open(sys.argv[1], "a", buffering=1)
QTYPES = {1: "A", 28: "AAAA", 65: "HTTPS", 5: "CNAME", 15: "MX", 16: "TXT", 12: "PTR", 33: "SRV"}


def question(data: bytes):
    labels, i = [], 12
    while i < len(data) and data[i]:
        n = data[i]
        labels.append(data[i + 1 : i + 1 + n].decode("ascii", "replace"))
        i += 1 + n
    qtype = struct.unpack("!H", data[i + 1 : i + 3])[0] if i + 3 <= len(data) else 0
    return ".".join(labels), QTYPES.get(qtype, str(qtype)), i + 5


def reply(data: bytes) -> bytes:
    name, qtype, end = question(data)
    LOG.write(f"{time.strftime('%H:%M:%S')} {qtype:5s} {name}\n")
    flags = 0x8183  # response, recursion desired+available, NXDOMAIN
    return data[:2] + struct.pack("!HHHHH", flags, 1, 0, 0, 0) + data[12:end]


class UDP(socketserver.BaseRequestHandler):
    def handle(self):
        data, sock = self.request
        if len(data) > 12:
            sock.sendto(reply(data), self.client_address)


class TCP(socketserver.BaseRequestHandler):
    def handle(self):
        raw = self.request.recv(2)
        if len(raw) == 2:
            data = self.request.recv(struct.unpack("!H", raw)[0])
            if len(data) > 12:
                out = reply(data)
                self.request.sendall(struct.pack("!H", len(out)) + out)


socketserver.ThreadingUDPServer.allow_reuse_address = True
socketserver.ThreadingTCPServer.allow_reuse_address = True
threading.Thread(target=socketserver.ThreadingTCPServer(("0.0.0.0", 53), TCP).serve_forever, daemon=True).start()
socketserver.ThreadingUDPServer(("0.0.0.0", 53), UDP).serve_forever()
