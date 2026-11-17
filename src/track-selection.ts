export function bindTrackSelection(root: HTMLElement, toggle: (index: number) => void): void {
  root.querySelectorAll<HTMLElement>('tr[data-action="selected"]').forEach(row => {
    const activate = () => {
      row.focus({ preventScroll: true });
      toggle(Number(row.dataset.track));
    };
    row.addEventListener("click", event => {
      const control = (event.target as HTMLElement).closest('input, select, button, a, label, [tabindex]');
      if (control && control !== row) return;
      activate();
    });
    row.addEventListener("keydown", event => {
      if (event.target !== row || (event.key !== " " && event.key !== "Enter")) return;
      event.preventDefault();
      if (!event.repeat) activate();
    });
  });
}
