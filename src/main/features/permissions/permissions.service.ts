import WebKit from 'gi://WebKit?version=6.0';
import { debug } from '../../core/debug';
import { parseUrl } from '../../core/url';
import type { PermissionName } from '~types/permissions';

function permissionName(request: WebKit.PermissionRequest): PermissionName {
  if (request instanceof WebKit.GeolocationPermissionRequest) return 'geolocation';
  if (request instanceof WebKit.UserMediaPermissionRequest) return 'media';
  if (request instanceof WebKit.NotificationPermissionRequest) return 'notifications';
  if (request instanceof WebKit.ClipboardPermissionRequest) return 'clipboard';
  if (request instanceof WebKit.WebsiteDataAccessPermissionRequest) return 'storage-access';
  if (request instanceof WebKit.DeviceInfoPermissionRequest) return 'device-info';
  if (request instanceof WebKit.MediaKeySystemPermissionRequest) return 'drm';
  return 'unknown';
}

/**
 * Denies every permission request unless the user has granted it for that origin.
 * There is no UI to grant permissions yet (see to-do.md), so the grant list stays empty and
 * everything is denied. `grant`/`revoke` are the hooks a future settings screen will call.
 */
export class PermissionsService {
  private readonly grants = new Map<string, Set<PermissionName>>();

  /** Answers a page's permission request. Always returns true: the request is handled here. */
  decide(pageUri: string | null, request: WebKit.PermissionRequest): boolean {
    const name = permissionName(request);
    const allowed = pageUri !== null && this.isGranted(pageUri, name);
    debug('permission', `${name} for ${pageUri ?? '(no page)'}: ${allowed ? 'granted' : 'denied'}`);
    if (allowed) {
      request.allow();
    } else {
      request.deny();
    }
    return true;
  }

  grant(origin: string, permission: PermissionName): void {
    const key = toOrigin(origin);
    if (key === null) return;
    const granted = this.grants.get(key) ?? new Set<PermissionName>();
    granted.add(permission);
    this.grants.set(key, granted);
  }

  revoke(origin: string, permission: PermissionName): void {
    const key = toOrigin(origin);
    if (key !== null) this.grants.get(key)?.delete(permission);
  }

  isGranted(origin: string, permission: PermissionName): boolean {
    const key = toOrigin(origin);
    return key !== null && (this.grants.get(key)?.has(permission) ?? false);
  }
}

function toOrigin(urlOrOrigin: string): string | null {
  return parseUrl(urlOrOrigin)?.origin ?? null;
}
