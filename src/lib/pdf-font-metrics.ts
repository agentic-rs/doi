interface PdfFontMetrics {
  ascent: number;
  descent: number;
}

/** Some embedded fonts report a collapsed or invalid bounding box (0, 0). */
export function pdfFontMetrics(style?: Partial<PdfFontMetrics>): PdfFontMetrics {
  const { ascent, descent } = style ?? {};
  if (ascent === undefined || descent === undefined || !Number.isFinite(ascent) || !Number.isFinite(descent) || ascent <= descent) {
    return { ascent: 0.8, descent: -0.2 };
  }
  return { ascent, descent };
}
