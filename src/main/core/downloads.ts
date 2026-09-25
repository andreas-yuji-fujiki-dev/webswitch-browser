import GLib from 'gi://GLib?version=2.0';
import { debug } from './debug';
import type WebKit from 'gi://WebKit?version=6.0';

/** Downloads go to the user's Downloads folder, never overwriting an existing file. */
export function handleDownloads(session: WebKit.NetworkSession): void {
  session.connect('download-started', (_session, download) => {
    debug('download', `started ${download.get_request().get_uri()}`);
    download.connect('failed', (_download, error) => {
      debug('download-failed', error.message);
    });
    download.connect('decide-destination', (_download, suggested) => {
      const folder =
        GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD) ?? GLib.get_home_dir();
      const destination = uniquePath(folder, suggested || 'download');
      debug('download', `saving to ${destination}`);
      download.set_destination(destination);
      return true;
    });
  });
}

function uniquePath(folder: string, name: string): string {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  let path = GLib.build_filenamev([folder, name]);
  for (let n = 1; GLib.file_test(path, GLib.FileTest.EXISTS); n++) {
    path = GLib.build_filenamev([folder, `${stem} (${n})${extension}`]);
  }
  return path;
}
