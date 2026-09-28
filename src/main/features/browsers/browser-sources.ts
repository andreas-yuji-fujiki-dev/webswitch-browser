import { compareVersions } from '~shared/version';
import type { CftVersion, InstallableBrowser, InstallPlan, VersionListing } from '~types/browsers';
import type { Http } from '../../core/http';

/** A release number as these vendors write them: "154.0.8037.57", "156.0.1", "140.16.0esr". */
export const RELEASE = /^\d{1,4}(\.\d{1,5}){1,3}(esr)?$/;

const numeric = (version: string): string => version.replace(/esr$/, '');
const major = (version: string): number => Number(numeric(version).split('.')[0]);

/** The newest release of every major version, newest first, from `minMajor` up. */
function perMajor(versions: string[], minMajor: number): string[] {
  const best = new Map<number, string>();
  for (const version of versions) {
    if (major(version) < minMajor) continue;
    const kept = best.get(major(version));
    if (kept === undefined || compareVersions(numeric(version), numeric(kept)) > 0) {
      best.set(major(version), version);
    }
  }
  return [...best.values()].sort((a, b) => compareVersions(numeric(b), numeric(a)));
}

// ── Chrome for Testing ─────────────────────────────────────────────────────────────────────────
const CFT = 'https://googlechromelabs.github.io/chrome-for-testing/';
const CFT_FILES = 'https://storage.googleapis.com/chrome-for-testing-public/';

async function cftStable(http: Http): Promise<string> {
  const known = await http.json<{ channels: { Stable: { version: string } } }>(
    `${CFT}last-known-good-versions.json`,
    100_000,
  );
  return known.channels.Stable.version;
}

// ── Firefox ────────────────────────────────────────────────────────────────────────────────────
const MOZILLA_PRODUCTS = 'https://product-details.mozilla.org/1.0/';
const MOZILLA_FILES = 'https://download-installer.cdn.mozilla.net/pub/firefox/releases/';

// ── Opera ──────────────────────────────────────────────────────────────────────────────────────
const OPERA = 'https://ftp.opera.com/ftp/pub/opera/desktop/';

// ── Edge ───────────────────────────────────────────────────────────────────────────────────────
const EDGE_POOL = 'https://packages.microsoft.com/repos/edge/pool/main/m/microsoft-edge-stable/';
const EDGE_PACKAGES =
  'https://packages.microsoft.com/repos/edge/dists/stable/main/binary-amd64/Packages';

/** Where a browser's program is inside the folder it was unpacked to, most likely first. */
export const EXECUTABLES: Record<InstallableBrowser, string[]> = {
  chrome: ['chrome-linux64/chrome'],
  firefox: ['firefox/firefox'],
  opera: ['usr/lib/x86_64-linux-gnu/opera-stable/opera', 'usr/lib/x86_64-linux-gnu/opera/opera'],
  edge: ['opt/microsoft/msedge/msedge'],
};

/** Every release each vendor offers for Linux (the ones from a known major on), newest first. */
export async function listVersions(id: InstallableBrowser, http: Http): Promise<VersionListing> {
  switch (id) {
    case 'chrome': {
      const stable = await cftStable(http);
      const all = await http.json<{ versions: CftVersion[] }>(
        `${CFT}known-good-versions-with-downloads.json`,
        12_000_000,
      );
      const withLinux = all.versions
        .filter((entry) => entry.downloads?.chrome?.some((file) => file.platform === 'linux64'))
        .map((entry) => entry.version)
        // Nothing newer than the stable release: those are Beta, Dev and Canary builds.
        .filter((version) => compareVersions(version, stable) <= 0 && RELEASE.test(version));
      const older = perMajor(withLinux, 113).filter((version) => major(version) < major(stable));
      return { versions: [stable, ...older], latest: stable };
    }
    case 'firefox': {
      const products = await http.json<{
        releases: Record<string, { category: string; version: string }>;
      }>(`${MOZILLA_PRODUCTS}firefox.json`, 2_000_000);
      const current = await http.json<{ LATEST_FIREFOX_VERSION: string }>(
        `${MOZILLA_PRODUCTS}firefox_versions.json`,
        100_000,
      );
      const releases = Object.values(products.releases).filter(
        (release) =>
          ['major', 'stability', 'esr'].includes(release.category) && RELEASE.test(release.version),
      );
      const normal = perMajor(
        releases.filter((release) => release.category !== 'esr').map((release) => release.version),
        115,
      );
      const esr = perMajor(
        releases.filter((release) => release.category === 'esr').map((release) => release.version),
        115,
      );
      const versions = [...normal, ...esr].sort((a, b) => {
        const byNumber = compareVersions(numeric(b), numeric(a));
        return byNumber !== 0 ? byNumber : Number(a.endsWith('esr')) - Number(b.endsWith('esr'));
      });
      return { versions, latest: current.LATEST_FIREFOX_VERSION };
    }
    case 'opera': {
      const page = await http.text(OPERA, 500_000);
      const found = [...page.matchAll(/href="(\d+\.\d+\.\d+\.\d+)\/"/g)].map(
        (match) => match[1] ?? '',
      );
      const versions = perMajor(
        found.filter((version) => RELEASE.test(version)),
        100,
      );
      return { versions, latest: versions[0] ?? '' };
    }
    case 'edge': {
      const page = await http.text(EDGE_POOL, 500_000);
      const found = [
        ...page.matchAll(/microsoft-edge-stable_(\d+\.\d+\.\d+\.\d+)-1_amd64\.deb/g),
      ].map((match) => match[1] ?? '');
      const versions = perMajor(
        found.filter((version) => RELEASE.test(version)),
        100,
      );
      return { versions, latest: versions[0] ?? '' };
    }
  }
}

/** The file to fetch for a release, and the checksum the vendor published for it, when there is one. */
export async function planInstall(
  id: InstallableBrowser,
  wanted: string | undefined,
  http: Http,
): Promise<InstallPlan> {
  switch (id) {
    case 'chrome': {
      const version = wanted ?? (await cftStable(http));
      const all = await http.json<{ versions: CftVersion[] }>(
        `${CFT}known-good-versions-with-downloads.json`,
        12_000_000,
      );
      const file = all.versions
        .find((entry) => entry.version === version)
        ?.downloads?.chrome?.find((candidate) => candidate.platform === 'linux64');
      if (!file?.url.startsWith(CFT_FILES)) {
        throw new Error(`Chrome for Testing has no Linux build of ${version}.`);
      }
      // Google publishes no checksum for these files; they come from its storage over HTTPS.
      return { version, url: file.url, kind: 'zip', sha256: null };
    }
    case 'firefox': {
      const version =
        wanted ??
        (
          await http.json<{ LATEST_FIREFOX_VERSION: string }>(
            `${MOZILLA_PRODUCTS}firefox_versions.json`,
            100_000,
          )
        ).LATEST_FIREFOX_VERSION;
      // Firefox 135 moved from .tar.bz2 to .tar.xz.
      const name = `firefox-${version}.tar.${major(version) >= 135 ? 'xz' : 'bz2'}`;
      const path = `linux-x86_64/en-US/${name}`;
      const sums = await http.text(`${MOZILLA_FILES}${version}/SHA256SUMS`, 1_000_000);
      const line = sums.split('\n').find((row) => row.trim().endsWith(` ${path}`));
      const sha256 = line?.trim().split(/\s+/)[0] ?? null;
      return { version, url: `${MOZILLA_FILES}${version}/${path}`, kind: 'tar', sha256 };
    }
    case 'opera': {
      const version = wanted ?? (await listVersions('opera', http)).latest;
      const base = `${OPERA}${version}/linux/opera-stable_${version}_amd64.deb`;
      let sha256: string | null = null;
      try {
        sha256 = (await http.text(`${base}.sha256sum`, 10_000)).trim().split(/\s+/)[0] ?? null;
      } catch {
        // No checksum file for this release: reported as not verified.
      }
      if (!(await http.exists(base))) throw new Error(`Opera has no Linux package of ${version}.`);
      return { version, url: base, kind: 'deb', sha256 };
    }
    case 'edge': {
      const version = wanted ?? (await listVersions('edge', http)).latest;
      const url = `${EDGE_POOL}microsoft-edge-stable_${version}-1_amd64.deb`;
      // Microsoft lists checksums only for its current packages; older ones cannot be verified.
      const packages = await http.text(EDGE_PACKAGES, 4_000_000);
      let sha256: string | null = null;
      for (const entry of packages.split('\n\n')) {
        if (!entry.includes('Package: microsoft-edge-stable\n')) continue;
        if (entry.includes(`Version: ${version}-1\n`)) {
          sha256 = /^SHA256: ([0-9a-f]{64})$/m.exec(entry)?.[1] ?? null;
        }
      }
      return { version, url, kind: 'deb', sha256 };
    }
  }
}
