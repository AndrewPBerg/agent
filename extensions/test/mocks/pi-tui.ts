export type AutocompleteItem = any;
export type Component = any;

export class Text {
  constructor(public text: string = "") {}
}

export class Markdown {
  text: string;
  paddingX: number;
  paddingY: number;
  theme: any;
  defaultTextStyle: any;
  options: Record<string, unknown>;

  constructor(text: string, paddingX = 0, paddingY = 0, theme: any = {}, defaultTextStyle?: any, options?: Record<string, unknown>) {
    this.text = text;
    this.paddingX = paddingX;
    this.paddingY = paddingY;
    this.theme = theme;
    this.defaultTextStyle = defaultTextStyle;
    this.options = { ...(options ?? {}) };
  }
}

export function getCapabilities() {
  return { hyperlinks: false, images: null, trueColor: false };
}

export function hyperlink(text: string) {
  return text;
}

export function wrapTextWithAnsi(value: string, width: number) {
  if (width <= 0 || value.length <= width) return [value];
  const lines: string[] = [];
  for (let i = 0; i < value.length; i += width) lines.push(value.slice(i, i + width));
  return lines;
}

export function matchesKey() {
  return false;
}

export function truncateToWidth(value: string, width: number) {
  return value.length > width ? value.slice(0, width) : value;
}

export function visibleWidth(value: string) {
  return value.length;
}
