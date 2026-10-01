import { describe, expect, it } from 'vitest';
import { buildReadingLayout, extractReadingPage, placeFiguresNearReferences } from './reading-layout';
import type { ReadingPageInput } from './reading-layout';
import type { ReadingBlock } from './types';

function pageFixture(page_number = 1, width = 600, height = 800) {
  const input: ReadingPageInput = {
    page_number,
    viewport: { width, height, scale: 1, rotation: 0, transform: [1, 0, 0, -1, 0, height],
      convertToPdfPoint: (x, y) => [x, height - y] },
    text_content: { items: [], styles: { body: { fontFamily: 'serif', ascent: 0.8, descent: -0.2, vertical: false } }, lang: 'en' },
    raster: { width, height, data: new Uint8ClampedArray(width * height * 4).fill(255) },
  };
  function ink(x: number, y: number, ink_width: number, ink_height: number) {
    for (let row = y; row < y + ink_height; row++) {
      for (let col = x; col < x + ink_width; col++) {
        const offset = (row * width + col) * 4;
        input.raster.data[offset] = input.raster.data[offset + 1] = input.raster.data[offset + 2] = 0;
      }
    }
  }
  function text(x: number, y: number, text_width: number, value: string, font_size = 10) {
    input.text_content.items.push({ str: value, dir: 'ltr', transform: [font_size, 0, 0, font_size, x, height - y - font_size * 0.8],
      width: text_width, height: font_size, fontName: 'body', hasEOL: true });
    ink(x, y, text_width, Math.floor(font_size * 0.8));
  }
  function graphic(x: number, y: number, graphic_width: number, graphic_height: number) {
    ink(x, y, graphic_width, 2);
    ink(x, y + graphic_height - 2, graphic_width, 2);
    ink(x, y, 2, graphic_height);
    ink(x + graphic_width - 2, y, 2, graphic_height);
  }
  function expectCompleteCoverage(blocks: ReadingBlock[]) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (input.raster.data[(y * width + x) * 4] === 255) continue;
        const covered = blocks.some(({ source_rect: [left, bottom, right, top] }) => x >= left && x + 1 <= right && height - y - 1 >= bottom && height - y <= top);
        if (!covered) throw new Error(`Uncovered PDF ink at ${x}, ${y}`);
      }
    }
  }
  return { input, text, graphic, ink, expectCompleteCoverage };
}

describe('conservative source-region analysis', () => {
  it('recognizes paragraphs and inline font switches when the body font reports zero bounds', () => {
    const page = pageFixture(3);
    page.input.text_content.styles.body.ascent = 0;
    page.input.text_content.styles.body.descent = 0;
    page.input.text_content.styles.emphasis = { fontFamily: 'serif', ascent: 0.8, descent: -0.2, vertical: false };
    page.text(50, 100, 240, 'Our evaluation compares several different models');
    page.text(294, 100, 206, 'and their translation quality.');
    const emphasis = page.input.text_content.items[1];
    if ('str' in emphasis) emphasis.fontName = 'emphasis';
    page.text(50, 114, 450, 'The resulting scores preserve the complete discussion of the experiment.');
    page.text(50, 145, 450, 'A second paragraph explains how the models respond in real time.');
    page.text(50, 159, 450, 'Every printed line remains selectable and available for line splitting.');
    const blocks = extractReadingPage(page.input);
    expect(blocks).toHaveLength(2);
    expect(blocks.every((block) => block.kind === 'text' && block.block_type === 'content')).toBe(true);
    expect(blocks[0].text.split('\n')).toEqual([
      'Our evaluation compares several different models and their translation quality.',
      'The resulting scores preserve the complete discussion of the experiment.',
    ]);
    page.expectCompleteCoverage(blocks);
  });

  it('crops real margins while retaining vector ink outside text bounds', () => {
    const page = pageFixture();
    page.text(100, 100, 350, 'Body text has several words to preserve its complete paragraph.');
    page.graphic(25, 160, 500, 180);
    const blocks = extractReadingPage(page.input);
    expect(Math.min(...blocks.map((block) => block.source_rect[0]))).toBe(22);
    expect(Math.max(...blocks.map((block) => block.source_rect[2]))).toBe(528);
    page.expectCompleteCoverage(blocks);
  });

  it.each([false, true])('reads two columns beneath a full-width heading in column order (zero font bounds: %s)', (zero_bounds) => {
    const page = pageFixture();
    if (zero_bounds) {
      page.input.text_content.styles.body.ascent = 0;
      page.input.text_content.styles.body.descent = 0;
    }
    page.text(50, 40, 500, 'A full width paper heading crosses the central gutter', 14);
    for (const [x, name] of [[50, 'Left'], [320, 'Right']] as const) {
      for (let index = 0; index < 6; index++) {
        page.text(x, 100 + index * 14, 230, `${name} paragraph line ${index} has enough prose to identify a column.`);
      }
      page.text(x, 205, 100, `${name} heading`);
      for (let index = 0; index < 3; index++) {
        page.text(x, 235 + index * 14, 230, `${name} second paragraph line ${index} continues the paper discussion.`);
      }
    }
    page.text(298, 740, 6, '1');
    const blocks = extractReadingPage(page.input);
    const text = blocks.map((block) => block.text).join('\n');
    expect(text.indexOf('Left second paragraph')).toBeLessThan(text.indexOf('Right paragraph'));
    const left_blocks = blocks.filter((block) => block.text.startsWith('Left'));
    expect(left_blocks.length).toBeGreaterThan(1);
    expect(new Set(left_blocks.map((block) => block.source_rect[2] - block.source_rect[0])).size).toBe(1);
    // The low-resolution raster cannot capture every antialiased italic edge.
    // Retain a safety inset inside the blank gutter on both column boundaries.
    expect(left_blocks.every((block) => block.source_rect[2] >= 282)).toBe(true);
    expect(blocks.filter((block) => block.text.startsWith('Right')).every((block) => block.source_rect[0] <= 318)).toBe(true);
    expect(blocks[0].text).toContain('full width paper heading');
    expect(blocks[0].block_type).toBe('title');
    expect(blocks.find((block) => block.text === '1')?.block_type).toBe('others');
    page.expectCompleteCoverage(blocks);
  });

  it('keeps a multipart vector figure, labels and caption together', () => {
    const page = pageFixture();
    page.graphic(70, 50, 180, 90);
    page.graphic(340, 50, 180, 90);
    page.text(110, 150, 85, 'First panel');
    page.text(380, 150, 95, 'Second panel');
    page.text(60, 182, 480, 'Figure 1: Two example graphs and their labels.');
    page.text(60, 196, 480, 'The caption continues below the graph in the original typography.');
    page.text(60, 240, 480, 'The results in Figure 1 show how our method changes over time.');
    page.text(60, 254, 480, 'This paragraph discusses the complete figure and its plotted values.');
    const blocks = extractReadingPage(page.input);
    const figure = blocks.find((block) => block.kind === 'figure');
    expect(figure?.block_type).toBe('graph');
    expect(figure?.figure_label).toBe('1');
    expect(figure?.text).toContain('First panel');
    expect(figure?.text).toContain('Second panel');
    expect(figure?.text).toContain('caption continues');
    expect(figure?.text).not.toContain('The results');
    const reordered = placeFiguresNearReferences(blocks);
    expect(reordered.findIndex((block) => block.block_id === figure?.block_id))
      .toBe(reordered.findIndex((block) => block.text.startsWith('The results')) + 1);
    page.expectCompleteCoverage(reordered);
  });

  it('separates narrow prose columns without joining their lines or splitting full-width tables', () => {
    const page = pageFixture();
    page.text(50, 40, 500, 'Table 1: The complete comparison across all evaluation conditions.');
    page.graphic(50, 65, 500, 60);
    for (const [x, name] of [[50, 'Left'], [310, 'Right']] as const) {
      for (let index = 0; index < 6; index++) {
        page.text(x, 160 + index * 14, 250, `${name} first paragraph line ${index} contains enough prose to identify its column.`);
      }
      for (let index = 0; index < 4; index++) {
        page.text(x, 270 + index * 14, 250, `${name} second paragraph line ${index} continues our discussion of the results.`);
      }
    }
    const blocks = extractReadingPage(page.input);
    const table = blocks.find((block) => block.block_type === 'table');
    expect(table).toBeDefined();
    expect(table!.source_rect[2] - table!.source_rect[0]).toBeGreaterThan(490);
    const left = blocks.filter((block) => block.text.startsWith('Left'));
    const right = blocks.filter((block) => block.text.startsWith('Right'));
    expect(left).toHaveLength(2);
    expect(right).toHaveLength(2);
    expect(left.every((block) => !block.text.includes('Right') && block.block_type === 'content')).toBe(true);
    expect(right.every((block) => !block.text.includes('Left') && block.block_type === 'content')).toBe(true);
    expect(blocks.indexOf(left[1])).toBeLessThan(blocks.indexOf(right[0]));
    page.expectCompleteCoverage(blocks);
  });

  it('keeps nearby figure panels together when a narrow gap has no prose column evidence', () => {
    const page = pageFixture();
    page.graphic(50, 50, 250, 110);
    page.graphic(310, 50, 250, 110);
    for (const x of [50, 310]) {
      page.text(x, 175, 180, 'Low latency');
      page.text(x, 189, 180, 'High quality');
      page.text(x, 203, 180, 'Model family');
    }
    page.text(50, 240, 510, 'Figure 1: Our comparison of two example model families.');
    const blocks = extractReadingPage(page.input);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: 'figure', block_type: 'graph', figure_label: '1' });
    page.expectCompleteCoverage(blocks);
  });

  it('does not extract a caption without an identifiable graphic', () => {
    const page = pageFixture();
    page.text(60, 60, 480, 'Figure 1: A textual example without any identifiable graphical area.');
    page.text(60, 100, 480, 'Figure 1 shows the result but this line is ordinary body prose.');
    expect(extractReadingPage(page.input).every((block) => block.kind !== 'figure')).toBe(true);
  });

  it('keeps a preceding section heading outside the extracted figure', () => {
    const page = pageFixture();
    page.text(60, 40, 180, '3 Model Architecture', 14);
    page.graphic(100, 80, 390, 120);
    page.text(60, 226, 480, 'Figure 1: The architecture of the model.');
    const blocks = extractReadingPage(page.input);
    expect(blocks[0]).toMatchObject({ kind: 'text', text: '3 Model Architecture' });
    expect(blocks[0].block_type).toBe('title');
    expect(blocks.find((block) => block.kind === 'figure')?.text).not.toContain('3 Model Architecture');
    page.expectCompleteCoverage(blocks);
  });

  it('does not mistake a horizontal rule beside a caption for a figure', () => {
    const page = pageFixture();
    page.ink(60, 100, 480, 2);
    page.text(60, 125, 480, 'Figure 1: A caption whose figure is elsewhere.');
    expect(extractReadingPage(page.input).every((block) => block.kind !== 'figure')).toBe(true);
  });

  it('keeps a bold figure number after the preceding words on its visual line', () => {
    const page = pageFixture();
    page.text(60, 100, 250, 'The comparison appears in Figure');
    page.text(314, 100, 150, '3 with its explanation.');
    page.input.text_content.styles.bold = { fontFamily: 'serif', ascent: 0.95, descent: -0.2, vertical: false };
    const number = page.input.text_content.items[1];
    if ('str' in number) number.fontName = 'bold';
    expect(extractReadingPage(page.input)[0].text).toBe('The comparison appears in Figure 3 with its explanation.');
  });

  it('keeps scans and rotated text regions in their original arrangement', () => {
    const scan = pageFixture();
    scan.graphic(40, 50, 520, 680);
    expect(extractReadingPage(scan.input)).toMatchObject([{ kind: 'original', source_rect: [37, 67, 563, 753] }]);
    const mixed = pageFixture();
    mixed.text(60, 100, 480, 'Normal body text should be kept together with its rotated labels.');
    mixed.input.text_content.items.push({ str: 'side label', dir: 'ltr', transform: [0, 10, -10, 0, 30, 350],
      width: 60, height: 10, fontName: 'body', hasEOL: true });
    expect(extractReadingPage(mixed.input).find((block) => block.text.includes('side label'))?.kind).toBe('original');
    mixed.expectCompleteCoverage(extractReadingPage(mixed.input));
  });

  it('maps a rotated page crop back to all four PDF-space corners', () => {
    const page = pageFixture(2, 800, 600);
    page.ink(20, 30, 400, 500);
    page.input.viewport.rotation = 90;
    page.input.viewport.transform = [0, 1, 1, 0, 0, 0];
    page.input.viewport.convertToPdfPoint = (x, y) => [y, x];
    expect(extractReadingPage(page.input)).toMatchObject([
      { page_number: 2, kind: 'original', source_rect: [27, 17, 533, 423] },
    ]);
  });

  it('extracts an intact plot with rotated labels and trims the gap above its footer', () => {
    const page = pageFixture();
    page.graphic(60, 60, 480, 190);
    page.input.text_content.items.push({ str: 'rotated label', dir: 'ltr', transform: [0, 10, -10, 0, 65, 600],
      width: 60, height: 10, fontName: 'body', hasEOL: true });
    page.text(60, 280, 480, 'Figure 3: Attention weights from a graph with many rotated labels.');
    page.text(60, 294, 480, 'The figure remains intact and the page marker is still preserved.');
    page.text(295, 745, 10, '13');
    const blocks = extractReadingPage(page.input);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ kind: 'figure', figure_label: '3' });
    expect(blocks[0].source_rect[1]).toBeGreaterThan(450);
    expect(blocks[1]).toMatchObject({ kind: 'text', text: '13' });
    page.expectCompleteCoverage(blocks);
  });

  it('preserves a blank page as a full source region', () => {
    expect(extractReadingPage(pageFixture().input)).toMatchObject([
      { kind: 'original', block_type: 'others', source_rect: [0, 0, 600, 800] },
    ]);
  });
});

function block(block_id: string, text: string, figure_label: string | null = null): ReadingBlock {
  return { block_id, page_number: 1, source_rect: [0, 0, 500, 700],
    kind: figure_label ? 'figure' : 'text', block_type: figure_label ? 'graph' : 'content', text, figure_label };
}

describe('figure placement', () => {
  it('moves a figure after the first clear explicit mention across pages', () => {
    const blocks = [block('opening', 'Opening paragraph.'), block('first', 'We compare the data in Fig. 2 below.'),
      block('second', 'Figure 2 also supports the conclusion.'), { ...block('figure', 'Figure 2: Results.', '2'), page_number: 3 }];
    expect(placeFiguresNearReferences(blocks).map((value) => value.block_id)).toEqual(['opening', 'first', 'figure', 'second']);
  });

  it('leaves duplicate numbering, unknown references and ranges unchanged', () => {
    const blocks = [block('mention', 'Figure 1 and 2 compare the methods. Figure 3(a) shows details. Figure 4-5 are a range.'),
      block('one-a', 'Figure 1: A', '1'), block('one-b', 'Figure 1: B', '1'), block('two', 'Figure 2: C', '2'),
      block('three', 'Figure 3: D', '3'), block('four', 'Figure 4: E', '4'), block('five', 'Figure 5: F', '5')];
    expect(placeFiguresNearReferences(blocks)).toEqual(blocks);
  });

  it('does not confuse Figure 1 with Figure 10 or move a figure after another caption', () => {
    const blocks = [block('mention', 'Figure 10 is discussed here.'), block('two', 'Figure 2: Compare Figure 1.', '2'),
      block('one', 'Figure 1: First result.', '1'), block('ten', 'Figure 10: Last result.', '10')];
    expect(placeFiguresNearReferences(blocks).map((value) => value.block_id)).toEqual(['mention', 'ten', 'two', 'one']);
  });

  it('accepts ordinary punctuation after a reference while rejecting lists', () => {
    const blocks = [block('ambiguous', 'Figure 1, 2 and 3 contain results.'),
      block('mention', 'The two branches appear in the left and right halves of Figure 1, respectively.'),
      block('later', 'More discussion.'), block('one', 'Figure 1: Architecture.', '1')];
    expect(placeFiguresNearReferences(blocks).map((value) => value.block_id)).toEqual(['ambiguous', 'mention', 'one', 'later']);
  });

  it('uses clear references inside preserved mathematical regions without treating captions as mentions', () => {
    const blocks = [{ ...block('caption', 'Figure 1: An uncertain caption.'), kind: 'original' as const },
      { ...block('math', 'The equation and Figure 1 describe the same result.'), kind: 'original' as const },
      block('later', 'Later paragraph.'), block('one', 'Figure 1: Architecture.', '1')];
    expect(placeFiguresNearReferences(blocks).map((value) => value.block_id)).toEqual(['caption', 'math', 'one', 'later']);
  });

  it('honors cancellation before allocating a page canvas', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(buildReadingLayout([], 'hash', controller.signal, () => {})).rejects.toMatchObject({ name: 'AbortError' });
  });
});
