export function createSnackbar() {
  const element = document.createElement("div");
  element.className = "snackbar";
  element.hidden = true;
  const message = document.createElement("span");
  message.setAttribute("role", "status");
  message.setAttribute("aria-live", "polite");
  message.setAttribute("aria-atomic", "true");
  const action = document.createElement("button");
  action.type = "button";
  action.textContent = "Undo";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "snackbar-close";
  close.setAttribute("aria-label", "Dismiss notification");
  close.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';
  const controls = document.createElement("div");
  controls.className = "snackbar-controls";
  controls.append(action, close);
  element.append(message, controls);
  document.body.append(element);
  let animation: Animation | undefined;
  const fade = (from: number, to: number, milliseconds: number, finish?: () => void) => {
    if (animation) {
      animation.onfinish = null;
      animation.cancel();
      animation = undefined;
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      finish?.();
      return;
    }
    animation = element.animate([{ opacity: from }, { opacity: to }], {
      duration: milliseconds, easing: "ease-out", fill: "forwards",
    });
    animation.onfinish = () => {
      animation?.cancel();
      animation = undefined;
      finish?.();
    };
  };
  let timer = 0;
  let duration = 0;
  let undo: (() => void) | undefined;
  const dismiss = () => {
    window.clearTimeout(timer);
    undo = undefined;
    element.inert = true;
    fade(1, 0, 100, () => {
      element.hidden = true;
      message.textContent = "";
    });
  };
  close.addEventListener("click", dismiss);
  const resume = () => {
    window.clearTimeout(timer);
    if (!element.hidden && !element.inert && !element.matches(":hover") && !element.contains(document.activeElement)) {
      timer = window.setTimeout(dismiss, duration);
    }
  };
  element.addEventListener("pointerenter", () => window.clearTimeout(timer));
  element.addEventListener("pointerleave", resume);
  element.addEventListener("focusin", () => window.clearTimeout(timer));
  element.addEventListener("focusout", () => queueMicrotask(resume));
  element.addEventListener("keydown", event => {
    if (event.key === "Escape") dismiss();
  });
  action.addEventListener("click", () => {
    const callback = undo;
    dismiss();
    callback?.();
  });
  return {
    dismiss,
    show(text: string, callback?: () => void) {
      window.clearTimeout(timer);
      undo = callback;
      action.hidden = !callback;
      element.inert = false;
      element.hidden = false;
      message.textContent = text.replace(/\.$/, "");
      fade(0, 1, 150);
      duration = callback ? 10000 : 5000;
      resume();
    },
  };
}
