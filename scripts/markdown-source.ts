// Helpers that map what a Markdown parser reports back to the source, since
// Bun.markdown hands its callbacks no positions.

const blank = (text: string) => text.replace(/[^\n]/g, " ");

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;

const INDENTED = /^(?: {4}|\t)/;

/**
 * Blanks out the source the prose check skips (fenced and indented code,
 * quotes, code spans and HTML comments) and keeps every offset, so a prose
 * fragment is located in prose and never in an earlier code example that
 * repeats it. Indented lines that continue a list item stay, since they
 * are prose.
 */
export function maskSkippedSource(markdown: string): string {
  let fence: string | null = null;
  let inIndentedCode = false;
  let previousBlank = true;
  let inList = false;

  const lines = markdown.split("\n").map((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    const isBlank = line.trim() === "";

    if (fence !== null) {
      if (
        marker !== undefined &&
        marker[0] === fence[0] &&
        marker.length >= fence.length
      ) {
        fence = null;
      }

      return blank(line);
    }

    if (marker !== undefined) {
      fence = marker;
      inIndentedCode = false;
      return blank(line);
    }

    if (INDENTED.test(line) && (inIndentedCode || (previousBlank && !inList))) {
      inIndentedCode = true;
      previousBlank = false;
      return blank(line);
    }

    if (!isBlank) {
      inIndentedCode = false;
      inList = LIST_ITEM.test(line) || (inList && INDENTED.test(line));
    }

    previousBlank = isBlank;

    return /^ {0,3}>/.test(line) ? blank(line) : line;
  });

  return lines
    .join("\n")
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/(`+)[^`][\s\S]*?\1/g, blank);
}

/**
 * The line, counted from 1, that holds the character at this offset.
 */
export function lineAt(text: string, offset: number): number {
  return text.slice(0, offset).split("\n").length;
}
