export type AutocompleteItem = any;
export type Component = any;

export class Text {
  constructor(public text: string = "") {}
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
