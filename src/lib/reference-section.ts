/** Shared boundaries for bibliography discovery, parsing, and Reading labels. */
export function isReferenceHeading(text: string): boolean {
  return /^(?:\d+\.?\s+)?(?:references|bibliography|literature cited)\s*$/i.test(text.trim());
}

export function isReferenceSectionEnd(text: string): boolean {
  return /^(?:appendix\b|attention visualizations|supplement(?:ary|al)\b|acknowledg(?:e)?ments\b|author biographies\b|[A-Z]\.?\s+(?:appendix|proof|additional|supplementary)\b)/i.test(text.trim());
}
