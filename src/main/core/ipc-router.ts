import JavaScriptCore from 'gi://JavaScriptCore?version=6.0';
import type WebKit from 'gi://WebKit?version=6.0';
import type {
  EventChannel,
  EventPayload,
  InvokeArgs,
  InvokeChannel,
  InvokeResult,
} from '~types/ipc';
import './webkit-async';

/**
 * Typed IPC between the native side and the browser's own UI views, on top of WebKit's script
 * message handlers. A handler named `ipc` is registered only on the views passed to `attach`
 * (the UI and its menu), so a tab, which never gets one, cannot call anything here.
 */
export class IpcRouter {
  private readonly handlers = new Map<string, (...args: never[]) => unknown>();
  private readonly views = new Set<WebKit.WebView>();

  attach(view: WebKit.WebView, manager: WebKit.UserContentManager): void {
    manager.register_script_message_handler_with_reply('ipc', null);
    manager.connect('script-message-with-reply-received::ipc', (_manager, value, reply) => {
      void this.dispatch(value, reply);
      return true;
    });
    this.views.add(view);
  }

  /**
   * A second UI view that shares the first one's web process and script bridge (the menu, or a
   * transient popover like the bookmarks star's): it needs no handler of its own, only to
   * receive events.
   */
  track(view: WebKit.WebView): void {
    this.views.add(view);
  }

  /**
   * For a `track`ed view that is about to be disposed (unlike the menu view, kept for the whole
   * run, a popover view is created and torn down each time it opens): without this, `emit` kept
   * calling `evaluate_javascript` on the dangling reference forever after, which is not just a
   * harmless "already disposed" warning -- left unfixed, it reliably crashed the process (found
   * from a real SIGSEGV at shutdown in the self-test, after the bookmarks popover's own view had
   * been disposed while still tracked here).
   */
  untrack(view: WebKit.WebView): void {
    this.views.delete(view);
  }

  handle<C extends InvokeChannel>(
    channel: C,
    handler: (...args: InvokeArgs<C>) => InvokeResult<C> | Promise<InvokeResult<C>>,
  ): void {
    this.handlers.set(channel, handler);
  }

  emit<C extends EventChannel>(channel: C, payload: EventPayload<C>): void {
    const script = `window.__wsEmit(${JSON.stringify(channel)}, ${JSON.stringify(payload)});`;
    for (const view of this.views) {
      view.evaluate_javascript(script, -1, null, null, null).catch(() => undefined);
    }
  }

  private async dispatch(
    value: JavaScriptCore.Value,
    reply: WebKit.ScriptMessageReply,
  ): Promise<void> {
    try {
      const message = JSON.parse(value.to_json(0)) as { channel?: unknown; args?: unknown };
      const handler =
        typeof message.channel === 'string' ? this.handlers.get(message.channel) : undefined;
      if (!handler || !Array.isArray(message.args)) {
        throw new Error(`Unknown IPC call: ${String(message.channel)}`);
      }
      const args: unknown[] = message.args;
      const result = await (handler as (...args: unknown[]) => unknown)(...args);
      reply.return_value(
        JavaScriptCore.Value.new_string(value.get_context(), JSON.stringify(result ?? null)),
      );
    } catch (error) {
      reply.return_error_message(error instanceof Error ? error.message : String(error));
    }
  }
}
