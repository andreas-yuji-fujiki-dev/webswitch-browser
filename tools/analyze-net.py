#!/usr/bin/env python3
"""Summarises a strace log made by measure-net.sh: only real network attempts, no local IPC."""
import re
import sys
from collections import Counter

INET = re.compile(
    r'(?P<call>connect|sendto|sendmsg)\(.*?sa_family=AF_(?P<fam>INET6?),.*?sin6?_port=htons\((?P<port>\d+)\).*?'
    r'(?:sin_addr=inet_addr\("(?P<a4>[^"]+)"\)|sin6_addr=inet_pton\(AF_INET6, "(?P<a6>[^"]+)"\))'
)
LOCAL = re.compile(r'^(127\.|0\.0\.0\.0$|::1$|::$)')

strace_log, dns_log = sys.argv[1], sys.argv[2]
dests, who, procs = Counter(), Counter(), {}
lines = 0
for line in open(strace_log, errors="replace"):
    lines += 1
    exe = re.match(r'(\d+) +\S+ execve\("([^"]+)"', line)
    if exe:
        procs[exe.group(1)] = exe.group(2)
    m = INET.search(line)
    if not m:
        continue
    addr = m.group("a4") or m.group("a6")
    if LOCAL.match(addr):
        continue
    dests[(m.group("call"), addr, int(m.group("port")))] += 1
    who[procs.get(line.split()[0], "pid " + line.split()[0])] += 1

asked = Counter()
for line in open(dns_log, errors="replace"):
    parts = line.split()
    if len(parts) == 3:
        asked[parts[2].lower()] += 1

print(f"strace lines: {lines}")
print(f"connections to non-local addresses: {sum(dests.values())}")
for (call, addr, port), n in dests.most_common(20):
    print(f"  {n:4d} x {call:8s} {addr}:{port}")
if who:
    print("made by:")
    for program, n in who.most_common():
        print(f"  {n:4d} x {program}")
print(f"DNS questions that reached the resolver: {sum(asked.values())} ({len(asked)} distinct names)")
for name, n in asked.most_common(30):
    print(f"  {n:4d} x {name}")
