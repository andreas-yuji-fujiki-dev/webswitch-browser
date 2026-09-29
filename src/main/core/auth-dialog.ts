import Gtk from 'gi://Gtk?version=4.0';
import WebKit from 'gi://WebKit?version=6.0';

const MARGIN = 16;
const SPACING = 10;

/**
 * The window a site's own sign-in asks for (HTTP authentication: "this site asks for a username and
 * password"). WebKitGTK shows nothing by itself, so without this a page behind such a login would
 * only ever show the error. Cancelling (or closing) tells the site nobody signed in.
 */
export function askCredentials(parent: Gtk.Window, request: WebKit.AuthenticationRequest): void {
  const window = new Gtk.Window({
    transient_for: parent,
    modal: true,
    title: 'Sign in',
    default_width: 380,
    resizable: false,
  });
  const box = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL,
    spacing: SPACING,
    margin_top: MARGIN,
    margin_bottom: MARGIN,
    margin_start: MARGIN,
    margin_end: MARGIN,
  });
  const realm = request.get_realm();
  const who = request.is_for_proxy() ? 'The proxy' : request.get_host();
  const heading = new Gtk.Label({
    label: `${who} asks you to sign in${realm ? `\n“${realm}”` : ''}`,
    xalign: 0,
    wrap: true,
  });
  const user = new Gtk.Entry({ placeholder_text: 'Username', activates_default: false });
  const password = new Gtk.PasswordEntry({ placeholder_text: 'Password', show_peek_icon: true });
  const cancel = new Gtk.Button({ label: 'Cancel' });
  const signIn = new Gtk.Button({ label: 'Sign in' });
  signIn.add_css_class('suggested-action');
  const buttons = new Gtk.Box({ spacing: SPACING, halign: Gtk.Align.END });
  buttons.append(cancel);
  buttons.append(signIn);
  box.append(heading);
  box.append(user);
  box.append(password);
  box.append(buttons);
  window.set_child(box);

  let answered = false;
  const submit = (): void => {
    answered = true;
    request.authenticate(
      new WebKit.Credential(
        user.get_text(),
        password.get_text(),
        WebKit.CredentialPersistence.FOR_SESSION,
      ),
    );
    window.close();
  };
  signIn.connect('clicked', submit);
  user.connect('activate', () => {
    password.grab_focus();
  });
  password.connect('activate', submit);
  cancel.connect('clicked', () => {
    window.close();
  });
  window.connect('close-request', () => {
    if (!answered) {
      answered = true;
      request.cancel();
    }
    return false;
  });
  window.present();
  user.grab_focus();
}
