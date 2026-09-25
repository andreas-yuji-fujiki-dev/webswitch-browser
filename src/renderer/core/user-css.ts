import { api } from './api-client';

const style = document.createElement('style');
style.id = 'user-css';

// Appending an element that is already in the document moves it, so the user stylesheet is
// always the last one in <head> and wins the cascade over everything else.
function apply(css: string): void {
  style.textContent = css;
  document.head.append(style);
}

export async function initUserCss(): Promise<void> {
  api.userCss.onChanged(apply);
  apply(await api.userCss.get());
}
