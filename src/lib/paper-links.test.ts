import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyPaperUrl, referenceLinkTarget } from './paper-links';

afterEach(() => vi.unstubAllGlobals());

describe('paper URL targets', () => {
  it.each([
    ['https://arxiv.org/abs/1706.03762', '1706.03762'],
    ['http://www.arxiv.org/pdf/1706.03762v7.pdf', '1706.03762v7'],
    ['https://export.arxiv.org/html/2401.12345v2#section.2', '2401.12345v2'],
    ['https://arxiv.org/abs/hep-th/9901001v2', 'hep-th/9901001v2'],
    ['https://arxiv.org/pdf/hep-th%2F9901001.pdf', 'hep-th/9901001'],
    ['https://ARXIV.ORG/abs/1706.03762?download=1', '1706.03762'],
  ])('routes official paper URL %s to the app', (url, arxiv_id) => {
    expect(classifyPaperUrl(url)).toEqual({ kind: 'app', arxiv_id, url: new URL(url).href });
  });

  it.each([
    'https://doi.org/10.48550/arXiv.1706.03762',
    'https://example.org/papers/research.pdf',
    'https://evil.test/arxiv.org/abs/1706.03762',
    'https://arxiv.org.evil.test/abs/1706.03762',
    'https://arxіv.org/abs/1706.03762',
    'https://arxiv.org:8443/abs/1706.03762',
    'https://arxiv.org/help',
    'https://arxiv.org/abs/1706.03762v0',
    'https://arxiv.org/abs/1706.03762.pdf.pdf',
    'https://arxiv.org/abs/1706.03762/extra',
    'https://arxiv.org/abs/%broken',
    'http://localhost:8000/paper',
  ])('requires browser confirmation for %s', (url) => {
    expect(classifyPaperUrl(url)).toEqual({ kind: 'external', url: new URL(url).href });
  });

  it.each([
    '', 'not a URL', '/abs/1706.03762', 'arxiv.org/abs/1706.03762',
    'javascript:alert(1)', 'data:text/html,hello', 'file:///etc/passwd', 'mailto:reader@example.org',
    'ftp://arxiv.org/abs/1706.03762', 'https://',
    'https://user@arxiv.org/abs/1706.03762',
    'https://arxiv.org:secret@evil.test/abs/1706.03762',
    'https://:secret@example.org/paper',
  ])('rejects unsafe or invalid URL %s', (url) => {
    expect(classifyPaperUrl(url)).toBeNull();
  });

  it('classifies without resolving links or requesting metadata', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(classifyPaperUrl('https://doi.org/10.48550/arXiv.1706.03762')?.kind).toBe('external');
    expect(classifyPaperUrl('https://arxiv.org/abs/1706.03762')?.kind).toBe('app');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('reference link targets', () => {
  it('prefers the arXiv identifier, then DOI, then the reference URL', () => {
    const reference = { arxiv_id: '1706.03762', doi: '10.48550/arXiv.1706.03762', url: 'https://example.org/paper' };
    expect(referenceLinkTarget(reference)).toEqual({
      kind: 'app', arxiv_id: '1706.03762', url: 'https://arxiv.org/abs/1706.03762',
    });
    expect(referenceLinkTarget({ ...reference, arxiv_id: null })).toEqual({
      kind: 'external', url: 'https://doi.org/10.48550/arXiv.1706.03762',
    });
    expect(referenceLinkTarget({ ...reference, arxiv_id: null, doi: null })).toEqual({
      kind: 'external', url: reference.url,
    });
  });

  it('recognizes URL-only arXiv references and rejects unavailable or unsafe links', () => {
    expect(referenceLinkTarget({ arxiv_id: null, doi: null, url: 'https://arxiv.org/pdf/1706.03762v7.pdf' })).toEqual({
      kind: 'app', arxiv_id: '1706.03762v7', url: 'https://arxiv.org/pdf/1706.03762v7.pdf',
    });
    expect(referenceLinkTarget({ arxiv_id: null, doi: null, url: null })).toBeNull();
    expect(referenceLinkTarget({ arxiv_id: null, doi: null, url: 'javascript:alert(1)' })).toBeNull();
  });
});
