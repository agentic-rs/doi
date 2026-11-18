// Write an ASCII PDF literal so byte offsets and content lengths stay exact.
function pdfLiteral(value: string): string {
  return [...value].map(char => {
    const code = char.codePointAt(0)!;
    if (code > 255) throw new Error('Test PDF text must fit the fixture font encoding.');
    if ('\\()'.includes(char)) return '\\' + char;
    return code < 32 || code >= 127 ? '\\' + code.toString(8).padStart(3, '0') : char;
  }).join('');
}

export function makePdf(contents: string[][], padding_bytes = 0) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${contents.map((_, i) => `${4 + 2 * i} 0 R`).join(' ')}] /Count ${contents.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (const lines of contents) {
    const stream = lines.map((line, i) => `BT /F1 11 Tf 40 ${740 - i * 15} Td (${pdfLiteral(line)}) Tj ET`).join('\n');
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objects.length + 2} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  let pdf = '%PDF-1.4\n';
  const entries = ['0000000000 65535 f '];
  for (const [i, object] of objects.entries()) {
    entries.push(`${String(pdf.length).padStart(10, '0')} 00000 n `);
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }
  pdf += ' '.repeat(padding_bytes);
  const xref = pdf.length;
  return new TextEncoder().encode(pdf + `xref\n0 ${entries.length}\n${entries.join('\n')}\ntrailer\n<< /Size ${entries.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
}
