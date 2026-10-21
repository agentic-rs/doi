/** Shared boundaries for bibliography discovery, parsing, and Reading labels. */
export function isReferenceHeading(text: string): boolean {
  return /^(?:\d+\.?\s+)?(?:references|bibliography|literature cited)\s*$/i.test(text.trim());
}

export function isReferenceSectionEnd(text: string, font_size = 0, body_font_size = Infinity): boolean {
  const value = text.trim();
  return /^(?:appendix\b|attention visualizations|supplement(?:ary|al)\b|acknowledg(?:e)?ments\b|author biographies\b|[A-Z]\.?\s+(?:appendix|proof|additional|supplementary)\b)/i.test(value)
    || (font_size >= body_font_size * 1.15 && value.length <= 180
      && /^\p{Lu}[\p{L}\p{N}\s–—-]+$/u.test(value) && !/\b(?:18|19|20)\d{2}\b/.test(value)
      && (value.match(/\p{L}{2,}/gu)?.length ?? 0) >= 2 && !isReferenceHeading(value));
}
