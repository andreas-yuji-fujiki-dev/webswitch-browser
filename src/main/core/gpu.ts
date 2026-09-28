import GLib from 'gi://GLib?version=2.0';

const EGL_VENDOR_DIRS = ['/usr/share/glvnd/egl_vendor.d', '/etc/glvnd/egl_vendor.d'];
const VULKAN_ICD_DIRS = ['/usr/share/vulkan/icd.d', '/etc/vulkan/icd.d'];

function jsonFiles(directory: string): string[] {
  try {
    const dir = GLib.Dir.open(directory, 0);
    const found: string[] = [];
    for (let name = dir.read_name(); name !== null; name = dir.read_name()) {
      if (name.endsWith('.json')) found.push(GLib.build_filenamev([directory, name]));
    }
    return found.sort();
  } catch {
    return [];
  }
}

/** The drivers of the discrete NVIDIA card and the CPU fallback are not wanted here. */
function integratedOnly(paths: string[]): string[] {
  return paths.filter((path) => !/nvidia|lvp|llvmpipe/i.test(path));
}

/**
 * The `integratedGpuOnly` setting (or `WEBSWITCH_GPU=integrated`) keeps the whole browser (the window and every web process) on the
 * integrated GPU of a hybrid laptop by hiding the discrete NVIDIA card from EGL and Vulkan. With
 * both cards visible, the window process opens both, and page contents can be drawn on one card
 * while the window is composed on another; this switch is there to rule that out when the
 * display flickers. Settings the user already made (`__EGL_VENDOR_LIBRARY_FILENAMES`,
 * `__GLX_VENDOR_LIBRARY_NAME`, `VK_DRIVER_FILES`) are left alone. Must run before GTK opens the display.
 */
export function applyGpuChoice(enabled: boolean): void {
  if (!enabled) return;
  if (GLib.getenv('__EGL_VENDOR_LIBRARY_FILENAMES') === null) {
    const egl = EGL_VENDOR_DIRS.flatMap((dir) => integratedOnly(jsonFiles(dir)));
    if (egl.length > 0) GLib.setenv('__EGL_VENDOR_LIBRARY_FILENAMES', egl.join(':'), true);
  }
  // On X11 (XWayland) the window may go through GLX instead of EGL.
  if (GLib.getenv('__GLX_VENDOR_LIBRARY_NAME') === null) {
    GLib.setenv('__GLX_VENDOR_LIBRARY_NAME', 'mesa', true);
  }
  if (GLib.getenv('VK_DRIVER_FILES') === null) {
    const vulkan = VULKAN_ICD_DIRS.flatMap((dir) => integratedOnly(jsonFiles(dir)));
    if (vulkan.length > 0) GLib.setenv('VK_DRIVER_FILES', vulkan.join(':'), true);
  }
}
