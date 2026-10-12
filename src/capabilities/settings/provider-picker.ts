import { groupProviderChoices, type ProviderSummary } from "#sdk/shared/settings";
import { getLocale, t } from "./i18n.js";

/** The select remains the form's value adapter; this view owns only search and focus. */
export function createProviderPicker({ root, signal }: { root: Document; signal?: AbortSignal }) {
  const select = root.querySelector<HTMLSelectElement>("#cfg-provider")!;
  const trigger = root.querySelector<HTMLButtonElement>("#cfg-provider-trigger")!;
  const value = root.querySelector<HTMLElement>("#cfg-provider-value")!;
  const popup = root.querySelector<HTMLElement>("#cfg-provider-picker")!;
  const search = root.querySelector<HTMLInputElement>("#cfg-provider-search")!;
  const list = root.querySelector<HTMLElement>("#cfg-provider-list")!;
  const empty = root.querySelector<HTMLElement>("#cfg-provider-empty")!;
  const controller = new AbortController();
  const listenerOptions = { signal: controller.signal };
  let groups: ReturnType<typeof groupProviderChoices> = [];
  let sections: { element: HTMLElement; entries: { element: HTMLElement; search: string }[] }[] = [];
  let items: HTMLElement[] = [];
  let activeIndex = -1;
  let placement: { upward: boolean; height: number } | null = null;

  function isOpen() { return popup.matches(":popover-open"); }

  function sync() {
    const label = select.selectedOptions[0]?.label || t("provider");
    value.textContent = label;
    trigger.title = label;
    for (const section of sections) for (const { element } of section.entries) {
      element.setAttribute("aria-selected", String(element.dataset.providerId === select.value));
    }
  }

  function refresh(providers: readonly ProviderSummary[]) {
    const selected = select.value;
    groups = groupProviderChoices(providers, getLocale());
    select.replaceChildren(...groups.flatMap(group => {
      const options = group.providers.map(provider => new Option(provider.label, provider.id));
      if (!group.id) return options;
      const element = root.createElement("optgroup");
      element.label = group.label;
      element.dataset.providerGroup = group.id;
      element.append(...options);
      return [element];
    }));
    if (providers.some(provider => provider.id === selected)) select.value = selected;
    buildOptions();
    sync();
    filter();
  }

  function highlight(index: number, scroll = true) {
    activeIndex = index;
    items.forEach((item, itemIndex) => item.classList.toggle("active", itemIndex === index));
    const active = items[index];
    if (active) {
      search.setAttribute("aria-activedescendant", active.id);
      if (scroll) {
        // Scroll only the popup list; scrollIntoView can also move the underlying settings form.
        const top = active.offsetTop - list.offsetTop;
        if (top < list.scrollTop) list.scrollTop = top;
        else if (top + active.offsetHeight > list.scrollTop + list.clientHeight) {
          list.scrollTop = top + active.offsetHeight - list.clientHeight;
        }
      }
    } else search.removeAttribute("aria-activedescendant");
  }

  function buildOptions() {
    let rowIndex = 0;
    sections = groups.map((group, groupIndex) => {
      const section = root.createElement("div");
      section.setAttribute("role", "group");
      if (group.label) {
        const label = root.createElement("div");
        label.id = `cfg-provider-group-${groupIndex}`;
        label.className = "provider-picker-group";
        label.textContent = group.label;
        section.setAttribute("aria-labelledby", label.id);
        section.append(label);
      }
      const entries = group.providers.map(provider => {
        const item = root.createElement("div");
        item.id = `cfg-provider-choice-${rowIndex++}`;
        item.dataset.providerId = provider.id;
        item.setAttribute("role", "option");
        item.setAttribute("aria-selected", String(provider.id === select.value));
        item.className = "qz-menu-item provider-picker-item";
        const label = root.createElement("span");
        label.dir = "auto";
        label.textContent = provider.label;
        const check = root.createElement("span");
        check.className = "provider-picker-check";
        check.setAttribute("aria-hidden", "true");
        check.textContent = "✓";
        item.append(label, check);
        section.append(item);
        return { element: item, search: `${provider.label} ${provider.id} ${group.label}`.toLocaleLowerCase(getLocale()) };
      });
      return { element: section, entries };
    });
    list.replaceChildren(...sections.map(section => section.element));
  }

  function filter() {
    const words = search.value.trim().toLocaleLowerCase(getLocale()).split(/\s+/).filter(Boolean);
    items = [];
    for (const section of sections) {
      let matches = 0;
      for (const entry of section.entries) {
        const visible = words.every(word => entry.search.includes(word));
        entry.element.hidden = !visible;
        if (visible) { items.push(entry.element); matches += 1; }
      }
      section.element.hidden = !matches;
    }
    empty.hidden = items.length > 0;
    list.hidden = !items.length;
    highlight(items.length ? 0 : -1, false);
    list.scrollTop = 0;
  }

  function position() {
    if (!isOpen()) return;
    const rect = trigger.getBoundingClientRect();
    const view = root.defaultView!;
    if (rect.bottom <= 0 || rect.top >= view.innerHeight) { close(); return; }
    for (let parent = trigger.parentElement; parent && parent !== root.body; parent = parent.parentElement) {
      if (view.getComputedStyle(parent).overflowY === "visible") continue;
      const bounds = parent.getBoundingClientRect();
      if (rect.bottom <= bounds.top || rect.top >= bounds.bottom) { close(); return; }
    }
    const gap = 5, inset = 8;
    const below = view.innerHeight - rect.bottom - gap - inset;
    const above = rect.top - gap - inset;
    popup.style.width = `${Math.min(rect.width, view.innerWidth - 2 * inset)}px`;
    if (!placement) {
      const upward = below < 220 && above > below;
      popup.style.maxHeight = `${Math.max(0, Math.min(360, upward ? above : below))}px`;
      placement = { upward, height: popup.offsetHeight };
    }
    // Keep search stationary while filtering; only viewport/anchor movement changes placement.
    const height = Math.max(0, Math.min(placement.height, placement.upward ? above : below));
    popup.style.height = `${height}px`;
    popup.style.maxHeight = `${height}px`;
    popup.style.left = `${Math.max(inset, Math.min(rect.left, view.innerWidth - rect.width - inset))}px`;
    popup.style.top = `${placement.upward ? Math.max(inset, rect.top - gap - height) : rect.bottom + gap}px`;
  }

  function open() {
    if (isOpen()) return;
    search.value = "";
    filter();
    placement = null;
    popup.style.removeProperty("height");
    popup.showPopover();
    trigger.setAttribute("aria-expanded", "true");
    search.setAttribute("aria-expanded", "true");
    position();
    search.focus({ preventScroll: true });
  }

  function close(restoreFocus = false) {
    const opened = isOpen();
    if (opened) popup.hidePopover();
    trigger.setAttribute("aria-expanded", "false");
    search.setAttribute("aria-expanded", "false");
    search.removeAttribute("aria-activedescendant");
    placement = null;
    if (opened && restoreFocus) trigger.focus({ preventScroll: true });
    return opened;
  }

  function choose(item: HTMLElement | undefined) {
    if (!item?.dataset.providerId) return;
    const changed = select.value !== item.dataset.providerId;
    select.value = item.dataset.providerId;
    sync();
    close(true);
    // Reuse the form's existing edit/auth/model lifecycle rather than keeping a second draft.
    if (changed) select.dispatchEvent(new Event("change", { bubbles: true }));
  }

  trigger.addEventListener("click", event => {
    // Keep the native invoker association for light dismiss, but own the search/focus transition.
    event.preventDefault();
    if (isOpen()) close(true);
    else open();
  }, listenerOptions);
  trigger.addEventListener("keydown", event => {
    if (["ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      open();
      if (event.key === "ArrowUp") highlight(items.length - 1);
    }
  }, listenerOptions);
  search.addEventListener("input", filter, listenerOptions);
  search.addEventListener("keydown", event => {
    if (event.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "Tab") close();
    else if (event.key === "Enter") {
      event.preventDefault();
      choose(items[activeIndex]);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (items.length) highlight((activeIndex + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length);
    }
  }, listenerOptions);
  list.addEventListener("mousedown", event => event.preventDefault(), listenerOptions);
  list.addEventListener("click", event => {
    const item = (event.target instanceof Element ? event.target : null)?.closest<HTMLElement>("[data-provider-id]");
    choose(item || undefined);
  }, listenerOptions);
  popup.addEventListener("toggle", () => {
    if (!isOpen()) close();
  }, listenerOptions);
  select.addEventListener("change", sync, listenerOptions);
  root.defaultView?.addEventListener("resize", position, listenerOptions);
  root.addEventListener("animationend", position, listenerOptions);
  root.addEventListener("scroll", event => {
    if (event.target instanceof Node && event.target.contains(trigger)) position();
  }, { ...listenerOptions, capture: true });
  function dispose() { close(); controller.abort(); }
  signal?.addEventListener("abort", dispose, { once: true });
  if (signal?.aborted) dispose();
  return { refresh, sync, close, isOpen, focus: () => trigger.focus(), dispose };
}
