#!/usr/bin/env python3
"""X11 helper for Webswitch's experimental embedded tabs (WEBSWITCH_EMBED_DRM=1).

GJS cannot call Xlib, so this small program does it, over stdin/stdout, one command per line:

  init <parent-xid>        create a container window inside <parent-xid> ("0": a test toplevel)
  adopt pid <n> | class <c> reparent the first managed window of that process / WM_CLASS into the container
  alive                    "ok 1" while the adopted window exists, "ok 0" once it is gone
  place <x> <y> <w> <h>    move and resize the container; the adopted window fills it
  show | hide              map or unmap the container
  focus                    give keyboard focus to the adopted window
  close                    ask the adopted window to close (WM_DELETE_WINDOW)
  shot <path>              write the container's pixels as a PNG (debugging)
  shotparent <path>        write the whole Webswitch window (the container's parent) as a PNG (debugging)
  geometry                 the container's, the adopted window's and the parent's x y width height (debugging)
  quit

Every command answers with one line: "ok ...", "wait" (nothing to adopt yet) or "error ...".
"""
import ctypes
import ctypes.util
import struct
import sys
import time
import zlib

x11 = ctypes.CDLL(ctypes.util.find_library('X11'))
Window = ctypes.c_ulong
x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XDefaultRootWindow.restype = Window
x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
x11.XCreateSimpleWindow.restype = Window
x11.XCreateSimpleWindow.argtypes = [ctypes.c_void_p, Window, ctypes.c_int, ctypes.c_int, ctypes.c_uint,
                                    ctypes.c_uint, ctypes.c_uint, ctypes.c_ulong, ctypes.c_ulong]
x11.XQueryTree.argtypes = [ctypes.c_void_p, Window, ctypes.POINTER(Window), ctypes.POINTER(Window),
                           ctypes.POINTER(ctypes.POINTER(Window)), ctypes.POINTER(ctypes.c_uint)]
x11.XReparentWindow.argtypes = [ctypes.c_void_p, Window, Window, ctypes.c_int, ctypes.c_int]
x11.XMoveResizeWindow.argtypes = [ctypes.c_void_p, Window, ctypes.c_int, ctypes.c_int, ctypes.c_uint, ctypes.c_uint]
x11.XMapWindow.argtypes = [ctypes.c_void_p, Window]
x11.XMapRaised.argtypes = [ctypes.c_void_p, Window]
x11.XUnmapWindow.argtypes = [ctypes.c_void_p, Window]
x11.XSetInputFocus.argtypes = [ctypes.c_void_p, Window, ctypes.c_int, ctypes.c_ulong]
x11.XInternAtom.restype = ctypes.c_ulong
x11.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
x11.XFree.argtypes = [ctypes.c_void_p]
x11.XFlush.argtypes = [ctypes.c_void_p]
x11.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
x11.XGetWindowProperty.argtypes = [ctypes.c_void_p, Window, ctypes.c_ulong, ctypes.c_long, ctypes.c_long,
                                    ctypes.c_int, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong),
                                    ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_ulong),
                                    ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.POINTER(ctypes.c_ubyte))]
x11.XWithdrawWindow.argtypes = [ctypes.c_void_p, Window, ctypes.c_int]
x11.XSelectInput.argtypes = [ctypes.c_void_p, Window, ctypes.c_long]


class ClassHint(ctypes.Structure):
    _fields_ = [('res_name', ctypes.c_char_p), ('res_class', ctypes.c_char_p)]


class ClientMessage(ctypes.Structure):
    _fields_ = [('type', ctypes.c_int), ('serial', ctypes.c_ulong), ('send_event', ctypes.c_int),
                ('display', ctypes.c_void_p), ('window', Window), ('message_type', ctypes.c_ulong),
                ('format', ctypes.c_int), ('l', ctypes.c_long * 5)]


class Event(ctypes.Union):
    _fields_ = [('type', ctypes.c_int), ('client', ClientMessage), ('pad', ctypes.c_long * 24)]


class Image(ctypes.Structure):
    _fields_ = [('width', ctypes.c_int), ('height', ctypes.c_int), ('xoffset', ctypes.c_int),
                ('format', ctypes.c_int), ('data', ctypes.POINTER(ctypes.c_ubyte)),
                ('byte_order', ctypes.c_int), ('bitmap_unit', ctypes.c_int), ('bitmap_bit_order', ctypes.c_int),
                ('bitmap_pad', ctypes.c_int), ('depth', ctypes.c_int), ('bytes_per_line', ctypes.c_int),
                ('bits_per_pixel', ctypes.c_int)]


x11.XGetClassHint.argtypes = [ctypes.c_void_p, Window, ctypes.POINTER(ClassHint)]
x11.XSendEvent.argtypes = [ctypes.c_void_p, Window, ctypes.c_int, ctypes.c_long, ctypes.POINTER(Event)]
x11.XGetImage.restype = ctypes.POINTER(Image)
x11.XGetImage.argtypes = [ctypes.c_void_p, Window, ctypes.c_int, ctypes.c_int, ctypes.c_uint, ctypes.c_uint,
                          ctypes.c_ulong, ctypes.c_int]

# Chrome or the window manager may destroy a window between two commands; that must not kill us.
HANDLER = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p)
_ignore = HANDLER(lambda _d, _e: 0)
x11.XSetErrorHandler(_ignore)

dpy = x11.XOpenDisplay(None)
if not dpy:
    print('error cannot open the X display', flush=True)
    sys.exit(1)
root = x11.XDefaultRootWindow(dpy)

container = 0
child = 0
size = (1, 1)


def client_windows():
    """The managed top-level windows, from the root's _NET_CLIENT_LIST."""
    actual, fmt = ctypes.c_ulong(), ctypes.c_int()
    count, after = ctypes.c_ulong(), ctypes.c_ulong()
    data = ctypes.POINTER(ctypes.c_ubyte)()
    atom = x11.XInternAtom(dpy, b'_NET_CLIENT_LIST', 0)
    x11.XGetWindowProperty(dpy, root, atom, 0, 4096, 0, 33, ctypes.byref(actual), ctypes.byref(fmt),
                           ctypes.byref(count), ctypes.byref(after), ctypes.byref(data))
    if not data or fmt.value != 32:
        return []
    wins = ctypes.cast(data, ctypes.POINTER(ctypes.c_ulong))
    found = [wins[i] for i in range(count.value)]
    x11.XFree(data)
    return found


def window_pid(w):
    actual, fmt = ctypes.c_ulong(), ctypes.c_int()
    count, after = ctypes.c_ulong(), ctypes.c_ulong()
    data = ctypes.POINTER(ctypes.c_ubyte)()
    atom = x11.XInternAtom(dpy, b'_NET_WM_PID', 0)
    x11.XGetWindowProperty(dpy, w, atom, 0, 1, 0, 6, ctypes.byref(actual), ctypes.byref(fmt),
                           ctypes.byref(count), ctypes.byref(after), ctypes.byref(data))
    if not data or fmt.value != 32 or count.value < 1:
        return 0
    pid = ctypes.cast(data, ctypes.POINTER(ctypes.c_ulong))[0]
    x11.XFree(data)
    return pid


def window_class(w):
    hint = ClassHint()
    if not x11.XGetClassHint(dpy, w, ctypes.byref(hint)):
        return (b'', b'')
    return (hint.res_name or b'', hint.res_class or b'')


def find_window(kind, value, skip):
    for w in client_windows():
        if w in skip:
            continue
        if kind == 'pid' and window_pid(w) == int(value):
            return w
        if kind == 'class' and value.encode() in window_class(w):
            return w
    return 0


def png(path, width, height, rgb):
    def chunk(tag, data):
        body = tag + data
        return struct.pack('>I', len(data)) + body + struct.pack('>I', zlib.crc32(body) & 0xFFFFFFFF)
    rows = b''.join(b'\x00' + rgb[y * width * 3:(y + 1) * width * 3] for y in range(height))
    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
                + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b''))


class Attributes(ctypes.Structure):
    _fields_ = [('x', ctypes.c_int), ('y', ctypes.c_int), ('width', ctypes.c_int), ('height', ctypes.c_int),
                ('pad', ctypes.c_byte * 200)]


x11.XGetWindowAttributes.argtypes = [ctypes.c_void_p, Window, ctypes.c_void_p]


def window_title(w):
    """_NET_WM_NAME (UTF-8), falling back to nothing; newlines are flattened to keep one line per answer."""
    actual, fmt = ctypes.c_ulong(), ctypes.c_int()
    count, after = ctypes.c_ulong(), ctypes.c_ulong()
    data = ctypes.POINTER(ctypes.c_ubyte)()
    x11.XGetWindowProperty(dpy, w, x11.XInternAtom(dpy, b'_NET_WM_NAME', 0), 0, 1024, 0,
                           x11.XInternAtom(dpy, b'UTF8_STRING', 0), ctypes.byref(actual), ctypes.byref(fmt),
                           ctypes.byref(count), ctypes.byref(after), ctypes.byref(data))
    if not data or fmt.value != 8:
        return ''
    text = ctypes.string_at(data, count.value).decode('utf-8', 'replace')
    x11.XFree(data)
    return ' '.join(text.split())


def parent_of(w):
    rt, parent, kids, count = Window(), Window(), ctypes.POINTER(Window)(), ctypes.c_uint()
    if not x11.XQueryTree(dpy, w, ctypes.byref(rt), ctypes.byref(parent), ctypes.byref(kids), ctypes.byref(count)):
        return 0
    if kids:
        x11.XFree(kids)
    return parent.value


def exists(w):
    """True while the window exists (an error from a destroyed window is swallowed by the handler)."""
    attrs = Attributes()
    return bool(x11.XGetWindowAttributes(dpy, w, ctypes.byref(attrs)))


def keep_in_place():
    """Some browsers move or resize their own window after it was placed (Edge puts itself at an
    offset once it has been reparented); the window must fill the container, so it is put back."""
    a = Attributes()
    if x11.XGetWindowAttributes(dpy, child, ctypes.byref(a)) and (a.x, a.y, a.width, a.height) != (0, 0, *size):
        x11.XMoveResizeWindow(dpy, child, 0, 0, *size)
        x11.XFlush(dpy)


def handle(parts):
    global container, child, size
    cmd, args = parts[0], parts[1:]
    if cmd == 'init':
        parent = int(args[0], 0) or root
        container = x11.XCreateSimpleWindow(dpy, parent, 0, 0, 100, 100, 0, 0, 0x000000)
        x11.XSync(dpy, 0)
        return f'ok {container:#x}'
    if cmd == 'adopt':
        deadline = time.time() + (int(args[2]) / 1000 if len(args) > 2 else 0)
        win = find_window(args[0], args[1], {container})
        while not win and time.time() < deadline:
            time.sleep(0.01)
            win = find_window(args[0], args[1], {container})
        if not win:
            return 'wait'
        child = win
        # The window manager owns a managed window (it wraps it in a frame and takes it back if it is
        # reparented while mapped). ICCCM 4.1.4: withdraw it first, wait until the manager has let go
        # of it (its parent is the root again), and only then reparent and map it.
        x11.XWithdrawWindow(dpy, child, 0)
        for _ in range(40):
            if parent_of(child) == root:
                break
            time.sleep(0.05)
        x11.XReparentWindow(dpy, child, container, 0, 0)
        x11.XMoveResizeWindow(dpy, child, 0, 0, *size)
        x11.XMapWindow(dpy, child)
        x11.XSync(dpy, 0)
        return f'ok {child:#x}'
    if cmd == 'title':
        return f'ok {window_title(child)}' if child else 'error nothing adopted'
    if cmd == 'alive':
        alive = bool(child and exists(child))
        if alive:
            keep_in_place()
        return f'ok {1 if alive else 0}'
    if cmd == 'place':
        x, y, w, h = (int(v) for v in args)
        size = (max(1, w), max(1, h))
        x11.XMoveResizeWindow(dpy, container, x, y, *size)
        if child:
            x11.XMoveResizeWindow(dpy, child, 0, 0, *size)
        x11.XFlush(dpy)
        return 'ok'
    if cmd == 'show':
        x11.XMapRaised(dpy, container)
        if child:
            x11.XMapWindow(dpy, child)
        x11.XFlush(dpy)
        return 'ok'
    if cmd == 'hide':
        x11.XUnmapWindow(dpy, container)
        x11.XFlush(dpy)
        return 'ok'
    if cmd == 'focus':
        if not child:
            return 'error nothing adopted'
        x11.XSetInputFocus(dpy, child, 1, 0)  # RevertToPointerRoot, CurrentTime
        x11.XFlush(dpy)
        return 'ok'
    if cmd == 'close':
        if not child:
            return 'error nothing adopted'
        ev = Event()
        ev.client.type = 33  # ClientMessage
        ev.client.window = child
        ev.client.message_type = x11.XInternAtom(dpy, b'WM_PROTOCOLS', 0)
        ev.client.format = 32
        ev.client.l[0] = x11.XInternAtom(dpy, b'WM_DELETE_WINDOW', 0)
        x11.XSendEvent(dpy, child, 0, 0, ctypes.byref(ev))
        x11.XFlush(dpy)
        return 'ok'
    if cmd == 'geometry':
        def rect(w):
            a = Attributes()
            return f'{a.x} {a.y} {a.width} {a.height}' if w and x11.XGetWindowAttributes(dpy, w, ctypes.byref(a)) else 'none'
        return f'ok container {rect(container)} child {rect(child)} parent {rect(parent_of(container))}'
    if cmd in ('shot', 'shotparent'):
        target = child or container
        shot_size = size
        if cmd == 'shotparent':
            target = parent_of(container)
            a = Attributes()
            x11.XGetWindowAttributes(dpy, target, ctypes.byref(a))
            shot_size = (a.width, a.height)
        img = x11.XGetImage(dpy, target, 0, 0, shot_size[0], shot_size[1], 0xFFFFFFFF, 2)  # ZPixmap
        if not img:
            return 'error XGetImage failed'
        im = img.contents
        raw = ctypes.string_at(im.data, im.bytes_per_line * im.height)
        rgb = bytearray()
        for y in range(im.height):
            line = raw[y * im.bytes_per_line:(y + 1) * im.bytes_per_line]
            for x in range(im.width):
                b, g, r = line[x * 4], line[x * 4 + 1], line[x * 4 + 2]
                rgb += bytes((r, g, b))
        png(args[0], im.width, im.height, bytes(rgb))
        return f'ok {im.width}x{im.height}'
    return f'error unknown command {cmd}'


for line in sys.stdin:
    parts = line.split()
    if not parts:
        continue
    if parts[0] == 'quit':
        break
    try:
        print(handle(parts), flush=True)
    except Exception as exc:  # the helper must outlive a bad command
        print(f'error {exc}', flush=True)
