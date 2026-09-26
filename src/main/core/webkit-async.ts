import WebKit from 'gi://WebKit?version=6.0';
import Gio from 'gi://Gio?version=2.0';

// GJS needs to be told which *_async functions to turn into promises. Imported for its effect.
Gio._promisify(WebKit.WebView.prototype, 'evaluate_javascript', 'evaluate_javascript_finish');
Gio._promisify(WebKit.WebView.prototype, 'get_snapshot', 'get_snapshot_finish');
Gio._promisify(WebKit.CookieManager.prototype, 'get_cookies', 'get_cookies_finish');
Gio._promisify(WebKit.CookieManager.prototype, 'add_cookie', 'add_cookie_finish');
Gio._promisify(WebKit.CookieManager.prototype, 'delete_cookie', 'delete_cookie_finish');
Gio._promisify(WebKit.WebsiteDataManager.prototype, 'fetch', 'fetch_finish');
