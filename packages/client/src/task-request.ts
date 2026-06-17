export function taskRequestTitle(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return text;

  const headingMatch = trimmed.match(/^#{1,6}\s+(.+)$/m);
  if (headingMatch?.[1]) return stripInlineMarkdown(headingMatch[1]);

  const firstLine = trimmed.split(/\r?\n/).find((line) => line.trim()) ?? trimmed;
  return stripInlineMarkdown(firstLine);
}

export function taskRequestPreview(text: string, maxLength = 120): string {
  const title = taskRequestTitle(text);
  if (title.length <= maxLength) return title;
  return `${title.slice(0, maxLength - 1)}…`;
}

function stripInlineMarkdown(line: string): string {
  return line
    .replace(/^#{1,6}\s+/, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[(.+?)\]\([^)]*\)/g, "$1")
    .trim();
}
